import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * 智能体路由（方案 §1）：技能目录、开会话（含第一轮）、续一轮、详情 / 改名 / 删除，
 * 以及「非本人一律 404」。写法照抄 `src/app/api/jobs/jobs-routes.test.ts`——直接调
 * handler，不起 HTTP 服务，同一套 session cookie 构造。
 *
 * 没有任何上游 key 时 `agentLlmConfig()` 落到确定性 mock（`llm.ts` 的 `mockCompleter`），
 * 所以这里不注入替身：跑的就是生产那条路径，只是提供方是 mock。
 */

const SESSION_SECRET = "agent-routes-test-secret-0123456789";
const UPSTREAM_KEYS = ["OPENAI_API_KEY", "YMAN_API_KEY", "XAI_API_KEY", "SUB2API_API_KEY", "KLING_API_KEY"] as const;

let dataRoot = "";
let saved: Record<string, string | undefined> = {};
let writeUser: typeof import("@/lib/users/store").writeUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;

let GET_SKILLS: typeof import("./skills/route").GET;
let GET_SESSIONS: typeof import("./sessions/route").GET;
let POST_SESSIONS: typeof import("./sessions/route").POST;
let GET_SESSION: typeof import("./sessions/[id]/route").GET;
let PATCH_SESSION: typeof import("./sessions/[id]/route").PATCH;
let DELETE_SESSION: typeof import("./sessions/[id]/route").DELETE;
let POST_MESSAGE: typeof import("./sessions/[id]/messages/route").POST;
let GET_TURN: typeof import("./sessions/[id]/turns/[turnId]/route").GET;
let POST_APPROVE: typeof import("./sessions/[id]/turns/[turnId]/approve/route").POST;
let POST_REJECT: typeof import("./sessions/[id]/turns/[turnId]/reject/route").POST;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-agent-routes-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  process.env.LUMEN_FORCE_MOCK = "1";
  // 开发机上可能真配着 key；这一组测试要的是确定性 mock 回复，不是一次真实调用。
  for (const key of UPSTREAM_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  ({ writeUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ GET: GET_SKILLS } = await import("./skills/route"));
  ({ GET: GET_SESSIONS, POST: POST_SESSIONS } = await import("./sessions/route"));
  ({ GET: GET_SESSION, PATCH: PATCH_SESSION, DELETE: DELETE_SESSION } = await import("./sessions/[id]/route"));
  ({ POST: POST_MESSAGE } = await import("./sessions/[id]/messages/route"));
  ({ GET: GET_TURN } = await import("./sessions/[id]/turns/[turnId]/route"));
  ({ POST: POST_APPROVE } = await import("./sessions/[id]/turns/[turnId]/approve/route"));
  ({ POST: POST_REJECT } = await import("./sessions/[id]/turns/[turnId]/reject/route"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  delete process.env.LUMEN_FORCE_MOCK;
  for (const key of UPSTREAM_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  saved = {};
  await cleanup(dataRoot);
});

/**
 * 这些用例真的把任务放进了 runner。收尾前必须等它跑空，理由有两条，第二条更要紧：
 *
 * 1. Windows 上删一个正被写的文件会 EBUSY。
 * 2. `DATA_DIR` 是进程级的，而 vitest 串行跑完这个文件就会换下一个文件的临时目录——
 *    还在后台跑的 runner 会把成片写进**别人**的目录里，把一个无关的用例弄挂。
 *
 * 等不到就只好放手：清理失败不该把一组通过的用例判成失败。
 */
async function cleanup(dir: string): Promise<void> {
  const { activeCount } = await import("@/lib/jobs/runner");
  for (let i = 0; i < 60; i += 1) {
    if ((await activeCount()) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function seedUser(id: string, balanceCny = 100): Promise<UserRecord> {
  const now = new Date().toISOString();
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "scrypt$16384$8$1$00$00",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: now,
    updatedAt: now,
  });
}

function cookieFor(user: UserRecord): string {
  return `${SESSION_COOKIE}=${issueSessionValue(user)}`;
}

function req(url: string, user: UserRecord | undefined, init: RequestInit = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.cookie = cookieFor(user);
  return new Request(url, { ...init, headers });
}

function jsonReq(url: string, user: UserRecord, method: string, body: unknown): Request {
  return req(url, user, { method, body: JSON.stringify(body) });
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function turnCtxFor(id: string, turnId: string) {
  return { params: Promise.resolve({ id, turnId }) };
}

type SessionJson = {
  id: string;
  messages: {
    id: string;
    role: string;
    approval?: string;
    jobs?: { jobId?: string; priceCny?: number }[];
    priceCny?: number;
  }[];
  turns: { id: string; status: string }[];
  jobs: { id: string; mode: string }[];
};

describe("GET /api/agent/skills", () => {
  it("needs a session", async () => {
    const res = await GET_SKILLS(req("http://localhost/api/agent/skills", undefined));
    expect(res.status).toBe(401);
  });

  it("lists the skills without leaking their system prompts", async () => {
    const user = await seedUser("usr_0000000000000201");
    const res = await GET_SKILLS(req("http://localhost/api/agent/skills", user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Record<string, unknown>[] };
    expect(body.skills.length).toBeGreaterThanOrEqual(20);
    expect(body.skills[0]).toHaveProperty("name");
    for (const skill of body.skills) expect(skill).not.toHaveProperty("systemPrompt");
  });
});

describe("agent sessions", () => {
  it("opens a session, proposes a job and files it on approval", async () => {
    const user = await seedUser("usr_0000000000000202");
    const res = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", {
        text: "生成一张海边黄昏的海报",
      }),
    );
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionJson & { title: string } };
    expect(session.id).toMatch(/^ses_[0-9a-f]{16}$/);
    expect(session.title).toContain("海报");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const assistant = session.messages[1];
    expect(assistant.priceCny).toBe(0.05);
    // 「海报」触发 mock 的 image action——默认批准制下它只是提案：待批、带报价、还没建任务。
    expect(assistant.approval).toBe("pending");
    expect(assistant.jobs?.[0].jobId).toBeUndefined();
    expect(assistant.jobs?.[0].priceCny).toBeGreaterThan(0);
    expect(session.jobs).toHaveLength(0);
    expect(session.turns[0].status).toBe("awaiting_approval");

    // 批准那一刻才创建任务：任务是普通的 text_to_image。
    const approved = await POST_APPROVE(
      req(`http://localhost/api/agent/sessions/${session.id}/turns/${assistant.id}/approve`, user, {
        method: "POST",
      }),
      turnCtxFor(session.id, assistant.id),
    );
    expect(approved.status).toBe(200);
    const after = (await approved.json()) as { session: SessionJson };
    const done = after.session.messages[1];
    expect(done.approval).toBe("approved");
    expect(done.jobs?.[0].jobId).toBeTruthy();
    expect(after.session.jobs[0].mode).toBe("text_to_image");
    expect(after.session.jobs[0].id).toBe(done.jobs?.[0].jobId);
    expect(after.session.turns[0].status).toBe("succeeded");

    // 单轮读取：刷新后拿 turn 状态恢复界面。
    const turnRes = await GET_TURN(
      req(`http://localhost/api/agent/sessions/${session.id}/turns/${assistant.id}`, user),
      turnCtxFor(session.id, assistant.id),
    );
    expect(turnRes.status).toBe(200);
    expect(((await turnRes.json()) as { turn: { status: string } }).turn.status).toBe("succeeded");
  });

  it("continues an existing session and lists it newest first", async () => {
    const user = await seedUser("usr_0000000000000203");
    const created = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "先聊聊想法" }),
    );
    const { session } = (await created.json()) as { session: { id: string } };

    const res = await POST_MESSAGE(
      jsonReq(`http://localhost/api/agent/sessions/${session.id}/messages`, user, "POST", {
        text: "那就生成一段视频",
      }),
      ctxFor(session.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: SessionJson };
    expect(body.session.messages).toHaveLength(4);
    const proposal = body.session.messages[3];
    expect(proposal.approval).toBe("pending");

    const approved = await POST_APPROVE(
      req(`http://localhost/api/agent/sessions/${session.id}/turns/${proposal.id}/approve`, user, {
        method: "POST",
      }),
      turnCtxFor(session.id, proposal.id),
    );
    const after = (await approved.json()) as { session: SessionJson };
    expect(after.session.jobs[0].mode).toBe("text_to_video");

    const listed = await GET_SESSIONS(req("http://localhost/api/agent/sessions", user));
    const list = (await listed.json()) as { sessions: { id: string }[] };
    expect(list.sessions[0].id).toBe(session.id);
  });

  it("rejects a proposal without filing any job", async () => {
    const user = await seedUser("usr_000000000000020a");
    const created = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "生成一张海报" }),
    );
    const { session } = (await created.json()) as { session: SessionJson };
    const proposal = session.messages[1];
    expect(proposal.approval).toBe("pending");

    const rejected = await POST_REJECT(
      req(`http://localhost/api/agent/sessions/${session.id}/turns/${proposal.id}/reject`, user, {
        method: "POST",
      }),
      turnCtxFor(session.id, proposal.id),
    );
    expect(rejected.status).toBe(200);
    const body = (await rejected.json()) as { session: SessionJson };
    expect(body.session.messages[1].approval).toBe("rejected");
    expect(body.session.jobs).toHaveLength(0);
    expect(body.session.turns[0].status).toBe("rejected");

    // 已拒绝的轮次不能再批准；不存在的轮次 404。
    const late = await POST_APPROVE(
      req(`http://localhost/api/agent/sessions/${session.id}/turns/${proposal.id}/approve`, user, {
        method: "POST",
      }),
      turnCtxFor(session.id, proposal.id),
    );
    expect(late.status).toBe(409);
    const missing = await GET_TURN(
      req(`http://localhost/api/agent/sessions/${session.id}/turns/msg_ffffffffffffffff`, user),
      turnCtxFor(session.id, "msg_ffffffffffffffff"),
    );
    expect(missing.status).toBe(404);
  });

  it("hides another user's session behind the same 404 as a missing one", async () => {
    const owner = await seedUser("usr_0000000000000204");
    const other = await seedUser("usr_0000000000000205");
    const created = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", owner, "POST", { text: "只属于我" }),
    );
    const { session } = (await created.json()) as { session: { id: string } };

    for (const res of [
      await GET_SESSION(req(`http://localhost/api/agent/sessions/${session.id}`, other), ctxFor(session.id)),
      await POST_MESSAGE(
        jsonReq(`http://localhost/api/agent/sessions/${session.id}/messages`, other, "POST", { text: "偷看" }),
        ctxFor(session.id),
      ),
      await DELETE_SESSION(
        req(`http://localhost/api/agent/sessions/${session.id}`, other, { method: "DELETE" }),
        ctxFor(session.id),
      ),
      await GET_SESSION(
        req("http://localhost/api/agent/sessions/ses_ffffffffffffffff", other),
        ctxFor("ses_ffffffffffffffff"),
      ),
    ]) {
      expect(res.status).toBe(404);
    }
    // 越权那几次一个字都没改到。
    const mine = await GET_SESSION(
      req(`http://localhost/api/agent/sessions/${session.id}`, owner),
      ctxFor(session.id),
    );
    expect(mine.status).toBe(200);
  });

  it("renames and deletes", async () => {
    const user = await seedUser("usr_0000000000000206");
    const created = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "会被改名" }),
    );
    const { session } = (await created.json()) as { session: { id: string } };

    const renamed = await PATCH_SESSION(
      jsonReq(`http://localhost/api/agent/sessions/${session.id}`, user, "PATCH", { title: "新标题" }),
      ctxFor(session.id),
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { session: { title: string } }).session.title).toBe("新标题");

    const removed = await DELETE_SESSION(
      req(`http://localhost/api/agent/sessions/${session.id}`, user, { method: "DELETE" }),
      ctxFor(session.id),
    );
    expect(removed.status).toBe(204);
    const gone = await GET_SESSION(
      req(`http://localhost/api/agent/sessions/${session.id}`, user),
      ctxFor(session.id),
    );
    expect(gone.status).toBe(404);
  });

  it("rejects an unknown field in the turn body", async () => {
    const user = await seedUser("usr_0000000000000207");
    const res = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "你好", model: "gpt-4o" }),
    );
    expect(res.status).toBe(400);
  });

  /**
   * 没有对话提供方的实例（2026-09-07）：两条写入路由都在扣款之前回 503，抽屉里也不留
   * 空壳。`KLING_API_KEY` 是为了让 `isMockMode()` 变假——它不在默认路由次序里，也不参与
   * 生图，不会把这一组用例里已经在跑的 mock 任务带上别的路。
   */
  it("answers 503 agent_unavailable on both write routes when no chat provider is configured", async () => {
    const user = await seedUser("usr_0000000000000209");
    // 先备一个正常会话，好验「续一轮」那条路由也被挡住。
    const created = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "先建一个会话" }),
    );
    const { session } = (await created.json()) as { session: { id: string } };

    delete process.env.LUMEN_FORCE_MOCK;
    process.env.KLING_API_KEY = "kling-test-key";
    try {
      for (const res of [
        await POST_SESSIONS(
          jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "还想聊" }),
        ),
        await POST_MESSAGE(
          jsonReq(`http://localhost/api/agent/sessions/${session.id}/messages`, user, "POST", {
            text: "再来一句",
          }),
          ctxFor(session.id),
        ),
      ]) {
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent_unavailable");
      }
      // 技能表照常可读，只是带上「不可用」，前端据此把输入卡置灰。
      const skills = await GET_SKILLS(req("http://localhost/api/agent/skills", user));
      expect(((await skills.json()) as { available: boolean }).available).toBe(false);
    } finally {
      process.env.LUMEN_FORCE_MOCK = "1";
      delete process.env.KLING_API_KEY;
    }

    // 被拒的那两次一个字都没写进去：还是原来那一条会话、原来那两条消息。
    const listed = await GET_SESSIONS(req("http://localhost/api/agent/sessions", user));
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    const detail = await GET_SESSION(
      req(`http://localhost/api/agent/sessions/${session.id}`, user),
      ctxFor(session.id),
    );
    expect(((await detail.json()) as { session: { messages: unknown[] } }).session.messages).toHaveLength(2);
  });

  it("does not leave an empty session behind when the first turn is refused", async () => {
    const user = await seedUser("usr_0000000000000208", 0);
    const res = await POST_SESSIONS(
      jsonReq("http://localhost/api/agent/sessions", user, "POST", { text: "没钱也想聊" }),
    );
    expect(res.status).toBe(402);
    const listed = await GET_SESSIONS(req("http://localhost/api/agent/sessions", user));
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });
});
