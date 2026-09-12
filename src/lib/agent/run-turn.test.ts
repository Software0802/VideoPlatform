import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentCompleter } from "./llm";

/**
 * 一轮对话（方案 §1）：扣款、幂等、action → `createJob`、单个任务失败不拖垮整轮、
 * 上游整个失败时退款。
 *
 * LLM 全程用注入的 completer，不发任何请求；生成任务走真实的 `createJob`（`LUMEN_FORCE_MOCK=1`），
 * 因为这里要验的正是「智能体建出来的就是普通任务」，替身会把这一点验没了。
 */

let dataRoot = "";
let runTurn: typeof import("./run-turn").runTurn;
let approveTurn: typeof import("./run-turn").approveTurn;
let rejectTurn: typeof import("./run-turn").rejectTurn;
let readTurn: typeof import("./run-turn").readTurn;
let createSession: typeof import("./store").createSession;
let readSession: typeof import("./store").readSession;
let patchSession: typeof import("./store").patchSession;
let hasEntryFor: typeof import("@/lib/billing/ledger").hasEntryFor;
let readUser: typeof import("@/lib/users/store").readUser;
let writeUser: typeof import("@/lib/users/store").writeUser;

const TURN_PRICE = 0.05;

/**
 * 对话提供方相关的环境变量。切换它们时连 `KLING_API_KEY` 一起管：`isMockMode()` 看的是
 * 「有没有任何上游 key」，不给它一把，实例就还是 mock 实例，永远试不出「不可用」那一档。
 * 用可灵那把是因为它不在默认路由次序里，也不参与生图——不会把这个文件里已经在跑的
 * mock 任务带上别的路（任务的 provider 在创建时就钉死了，runner 只读 `job.provider`）。
 */
const PROVIDER_ENV = [
  "LUMEN_FORCE_MOCK",
  "AGENT_API_KEY",
  "AGENT_BASE_URL",
  "AGENT_CHAT_MODEL",
  "XAI_API_KEY",
  "SUB2API_API_KEY",
  "OPENAI_API_KEY",
  "YMAN_API_KEY",
  "KLING_API_KEY",
] as const;

function snapshotProviderEnv(): Record<string, string | undefined> {
  return Object.fromEntries(PROVIDER_ENV.map((key) => [key, process.env[key]]));
}

function restoreProviderEnv(saved: Record<string, string | undefined>): void {
  for (const key of PROVIDER_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

/** 非 mock 实例、但一把对话 key 都没有——正是生产上「只配了生图中转」的那个形状。 */
function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV) delete process.env[key];
  process.env.KLING_API_KEY = "kling-test-key";
}

/** 回一段固定 JSON 的替身；`reply` 里带上轮次以便断言不是缓存。 */
function completerReturning(payload: unknown): AgentCompleter {
  return async () => JSON.stringify(payload);
}

async function seedUser(id: string, balanceCny: number) {
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

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-agent-turn-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ runTurn, approveTurn, rejectTurn, readTurn } = await import("./run-turn"));
  ({ createSession, readSession, patchSession } = await import("./store"));
  ({ hasEntryFor } = await import("@/lib/billing/ledger"));
  ({ readUser, writeUser } = await import("@/lib/users/store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
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

/**
 * 提供方选择（2026-09-07）。生图那几把 key 不再参与——生产的 `OPENAI_BASE_URL`（ccgoai）
 * 与 YMan 都是只出图的中转，`/chat/completions` 回 503 / 400，排进来只会让每轮都
 * 「扣款 → 失败 → 退款」。
 */
describe("agentLlmConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = snapshotProviderEnv();
  });

  afterEach(() => {
    restoreProviderEnv(saved);
  });

  it("uses AGENT_API_KEY with its own base URL when it is set", async () => {
    clearProviderEnv();
    process.env.AGENT_API_KEY = "sk-agent-test";
    process.env.XAI_API_KEY = "xai-should-not-win";
    const { agentLlmConfig, DEFAULT_AGENT_MODEL } = await import("./llm");
    expect(agentLlmConfig()).toEqual({
      provider: "agent",
      model: DEFAULT_AGENT_MODEL,
      apiKey: "sk-agent-test",
      baseURL: "https://api.openai.com/v1",
    });

    process.env.AGENT_BASE_URL = "https://chat.example.com";
    // base URL 缺 `/v1` 时补上，和别的 OpenAI 兼容端点同一个口径。
    expect(agentLlmConfig()?.baseURL).toBe("https://chat.example.com/v1");
  });

  it("falls back to xAI's grok when only XAI_API_KEY is set", async () => {
    clearProviderEnv();
    process.env.XAI_API_KEY = "xai-test";
    const { agentLlmConfig, DEFAULT_AGENT_MODEL_XAI } = await import("./llm");
    expect(agentLlmConfig()).toMatchObject({
      provider: "xai",
      model: DEFAULT_AGENT_MODEL_XAI,
      apiKey: "xai-test",
    });
  });

  it("is unavailable when only the image-only upstreams are configured", async () => {
    clearProviderEnv();
    // 生产上真实存在的那台：ccgoai 生图 key + YMan 视频 key，一个都不会说话。
    process.env.OPENAI_API_KEY = "sk-image-only";
    process.env.YMAN_API_KEY = "yman-image-only";
    const { agentAvailable, agentLlmConfig, requireAgentLlmConfig } = await import("./llm");
    expect(agentLlmConfig()).toBeNull();
    expect(agentAvailable()).toBe(false);
    let thrown: unknown;
    try {
      requireAgentLlmConfig();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ status: 503, code: "agent_unavailable" });
  });

  it("stays on mock for a mock instance even with a chat key present", async () => {
    clearProviderEnv();
    process.env.LUMEN_FORCE_MOCK = "1";
    process.env.AGENT_API_KEY = "sk-agent-test";
    const { agentAvailable, agentLlmConfig } = await import("./llm");
    expect(agentLlmConfig()).toMatchObject({ provider: "mock" });
    expect(agentAvailable()).toBe(true);
  });
});

describe("runTurn", () => {
  it("charges the turn once under an idempotent ref; the job is only filed after approval", async () => {
    const owner = "usr_0000000000000101";
    await seedUser(owner, 100);
    const session = await createSession(owner, { title: "海报" });

    const first = await runTurn(
      session,
      { ownerId: owner, text: "生成一张海边黄昏的海报" },
      {
        complete: completerReturning({
          reply: "这就来。",
          actions: [{ type: "image", prompt: "海边黄昏的海报，暖调侧光，保持色板不变" }],
        }),
      },
    );

    // 默认批准制：actions 不再直接建任务——提案停在 awaiting_approval，消息带 pending 报价。
    expect(first.turn.status).toBe("awaiting_approval");
    expect(first.turn.proposal?.actions).toHaveLength(1);
    expect(first.turn.proposal!.totalCny).toBeGreaterThan(0);
    expect(first.assistant?.approval).toBe("pending");
    expect(first.assistant?.jobs?.[0].jobId).toBeUndefined();
    expect(first.session.jobIds).toEqual([]);

    // 批准那一刻才创建任务、才扣任务钱。
    const { session: next, assistant } = await approveTurn(owner, session.id, first.turn.id);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.priceCny).toBe(TURN_PRICE);
    expect(assistant?.approval).toBe("approved");
    expect(assistant?.jobs).toHaveLength(1);
    expect(assistant?.jobs?.[0].jobId).toMatch(/^job_[0-9a-f]{12}$/);
    expect(assistant?.jobs?.[0].error).toBeUndefined();
    // 会话里既留下了对话，也留下了这条任务的 id（资产栏读的就是它）。
    expect(next.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(next.jobIds).toEqual([assistant?.jobs?.[0].jobId]);
    expect(next.turns?.find((x) => x.id === first.turn.id)?.status).toBe("succeeded");

    const ref = `agent:${first.turn.id}`;
    await expect(hasEntryFor(owner, "charge", ref)).resolves.toBe(true);

    // 幂等键真的注册上了：同 kind + 同 ref + 同输入的重放是空操作
    //（同 ref 但输入不同会被判 billing_idempotency_conflict，见 file-ledger.test.ts）。
    const { applyBalanceChange } = await import("@/lib/billing/ledger");
    const before = (await readUser(owner))?.balanceCny ?? 0;
    await applyBalanceChange(owner, -TURN_PRICE, {
      kind: "charge",
      amountCny: -TURN_PRICE,
      ref,
      note: "智能体对话",
    });
    expect((await readUser(owner))?.balanceCny).toBe(before);
  });

  it("keeps the turn alive when one of two actions cannot be filed", async () => {
    const owner = "usr_0000000000000102";
    // 够付一轮对话（0.05）+ 一张图（0.5），不够付第二张。
    await seedUser(owner, 0.7);
    const session = await createSession(owner, { title: "两张图" });

    const { turn } = await runTurn(
      session,
      { ownerId: owner, text: "生成两张海报" },
      {
        complete: completerReturning({
          reply: "出两版。",
          actions: [
            { type: "image", prompt: "第一版，冷调，保持构图不变" },
            { type: "image", prompt: "第二版，暖调，保持构图不变" },
          ],
        }),
      },
    );
    const { assistant } = await approveTurn(owner, session.id, turn.id);

    expect(assistant?.jobs).toHaveLength(2);
    expect(assistant?.jobs?.[0].jobId).toBeTruthy();
    expect(assistant?.jobs?.[1].jobId).toBeUndefined();
    // 用户要看得到「这条为什么没出来」，而不是整轮失败。
    expect(assistant?.jobs?.[1].error).toBeTruthy();
    expect(assistant?.text).toBe("出两版。");
  });

  it("caps a turn at two actions no matter how many the model returns", async () => {
    const owner = "usr_0000000000000103";
    await seedUser(owner, 100);
    const session = await createSession(owner, { title: "贪心的模型" });

    const { turn, assistant } = await runTurn(
      session,
      { ownerId: owner, text: "生成海报" },
      {
        complete: completerReturning({
          reply: "只做前两条。",
          actions: [1, 2, 3, 4].map((n) => ({ type: "image", prompt: `第 ${n} 版，保持色板不变` })),
        }),
      },
    );
    // 上限落在提案上：挂出去的报价最多两条。
    expect(turn.proposal?.actions).toHaveLength(2);
    expect(assistant?.jobs).toHaveLength(2);
  });

  it("refunds the turn when the model never returns a usable reply", async () => {
    const owner = "usr_0000000000000104";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "上游挂了" });

    await expect(
      runTurn(
        session,
        { ownerId: owner, text: "随便说点什么" },
        {
          complete: async () => {
            throw new Error("upstream down");
          },
        },
      ),
    ).rejects.toMatchObject({ status: 502, code: "agent_upstream_failed" });

    // 「上游挂了不该用户掏钱」：钱已经扣了，所以这里必须退回去。
    expect((await readUser(owner))?.balanceCny).toBe(10);
    // B 包：用户消息与 turn 账本在扣款那一刻已落盘——留下「问了但没答上」的痕迹，
    // turn 标 failed 且带退款引用，下一轮（新 turnId）照常能发。
    const stored = await readSession(owner, session.id);
    expect(stored?.messages.map((m) => m.role)).toEqual(["user"]);
    expect(stored?.turns?.[0]).toMatchObject({
      status: "failed",
      refundRef: expect.stringContaining(":refund"),
      error: { code: "agent_upstream_failed" },
    });
  });

  it("R02：整轮失败退款按原扣款的分池原路退回，会员积分不转成已购余额", async () => {
    const owner = "usr_0000000000000108";
    const now = new Date();
    const subId = "sub_00000000000000aa";
    // 有效订阅 + 全会员积分、已购池为 0：这一轮 ¥0.05 会整笔从会员池出。
    // R05 起准入会先跑惰性结算，所以这份订阅要装成「已结算」的样子——本期积分入账行
    // （p0）与当日标记都得在，否则结算会先补发一圈，干扰对退款路径的断言。
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    await writeUser({
      id: owner,
      email: `${owner}@example.com`,
      passwordHash: "scrypt$16384$8$1$00$00",
      sessionEpoch: 1,
      plan: "free",
      balanceCny: 0,
      memberCreditsCny: 0,
      subscription: {
        id: subId,
        planId: "standard",
        cycle: "monthly",
        startedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 86400_000).toISOString(),
        periodIndex: 0,
        periodStartedAt: now.toISOString(),
        lastDailyGrantOn: today,
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const { applyBalanceChange } = await import("@/lib/billing/ledger");
    await applyBalanceChange(
      owner,
      1,
      { kind: "grant", amountCny: 1, ref: `sub:${subId}:p0`, note: "订阅本期会员积分" },
      { pool: "member" },
    );
    const session = await createSession(owner, { title: "退款回池" });

    await expect(
      runTurn(
        session,
        { ownerId: owner, text: "随便说点什么" },
        {
          complete: async () => {
            throw new Error("upstream down");
          },
        },
      ),
    ).rejects.toMatchObject({ status: 502, code: "agent_upstream_failed" });

    const user = await readUser(owner);
    // 修复前：会员出的 0.05 被退进已购池（会员 0.95 + 已购 0.05），会员积分被套现。
    // 修复后：原路回池——会员池回到 1，已购池仍为 0。
    expect(user?.balanceCny).toBe(0);
    expect(user?.memberCreditsCny).toBe(1);
    // 退款行的 memberCny 记的是「退回会员池的金额」，对账能看出来路。
    const { readLedger } = await import("@/lib/billing/ledger");
    const { entries } = await readLedger(owner);
    const refund = entries.find((e) => e.ref?.endsWith(":refund"));
    expect(refund).toMatchObject({ kind: "adjust", amountCny: TURN_PRICE, memberCny: TURN_PRICE });
  });

  it("R08：同 turnId 的重放原样交回那一轮——不重复扣款、不重复调 LLM、不写重消息", async () => {
    const owner = "usr_0000000000000109";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "重放" });
    const turnId = "msg_aabbccddeeff0011";
    let llmCalls = 0;

    const first = await runTurn(
      session,
      { ownerId: owner, text: "生成一张海报", turnId },
      {
        complete: async () => {
          llmCalls += 1;
          return JSON.stringify({ reply: "这就来。", actions: [] });
        },
      },
    );
    const balanceAfterFirst = (await readUser(owner))?.balanceCny;

    // 同一笔请求在网络上被透明重发：turnId 原样带回，服务端必须认账而不重做。
    const again = await runTurn(
      session,
      { ownerId: owner, text: "生成一张海报", turnId },
      { complete: completerReturning({ reply: "不该被走到", actions: [] }) },
    );
    expect(again.assistant?.id).toBe(first.assistant?.id);
    expect(again.assistant?.text).toBe("这就来。");
    expect(again.session.messages).toHaveLength(2);
    expect(llmCalls).toBe(1);
    expect((await readUser(owner))?.balanceCny).toBe(balanceAfterFirst);
    const { readLedger } = await import("@/lib/billing/ledger");
    const { entries } = await readLedger(owner);
    expect(entries.filter((e) => e.ref === `agent:${turnId}`)).toHaveLength(1);
  });

  it("R08：同 turnId 换文本是 409 冲突，不是重放", async () => {
    const owner = "usr_000000000000010a";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "换参" });
    const turnId = "msg_0011223344556677";
    await runTurn(
      session,
      { ownerId: owner, text: "第一句", turnId },
      { complete: completerReturning({ reply: "好。", actions: [] }) },
    );
    await expect(
      runTurn(
        session,
        { ownerId: owner, text: "换了一句", turnId },
        { complete: completerReturning({ reply: "不该被走到", actions: [] }) },
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect((await readSession(owner, session.id))?.messages).toHaveLength(2);
  });

  it("与 POST /api/jobs 共用同一个限流桶：桶满时该 action 记码，整轮照常出回复", async () => {
    const owner = "usr_0000000000000106";
    await seedUser(owner, 100);
    const session = await createSession(owner, { title: "限流" });

    const { JOBS_RATE_LIMIT, consumeJobCreation } = await import("@/lib/jobs/rate-limit");
    const { resetRateLimits } = await import("@/lib/users/rate-limit");
    resetRateLimits();
    try {
      // 把这个用户的任务创建桶打满——正是 `POST /api/jobs` 消费的那一个。智能体不共用
      // 它的话，「让智能体替我一次开二十条」就是这条限流的现成绕过路径。
      for (let i = 0; i < JOBS_RATE_LIMIT; i += 1) {
        expect(consumeJobCreation(owner).allowed).toBe(true);
      }

      const { turn } = await runTurn(
        session,
        { ownerId: owner, text: "再来一张" },
        {
          complete: completerReturning({
            reply: "这就来。",
            actions: [{ type: "image", prompt: "第 11 张，保持色板不变" }],
          }),
        },
      );
      const { assistant } = await approveTurn(owner, session.id, turn.id);

      expect(assistant?.jobs).toHaveLength(1);
      expect(assistant?.jobs?.[0].jobId).toBeUndefined();
      // 码而不是文案：翻译是前端字典的事（`agent.jobRateLimited`）。
      expect(assistant?.jobs?.[0].error).toBe("rate_limited");
      // 整轮没有失败：回复照常出，钱也照常按一轮收。
      expect(assistant?.text).toBe("这就来。");
      expect(assistant?.priceCny).toBe(TURN_PRICE);
    } finally {
      resetRateLimits();
    }
  });

  /**
   * 一家对话提供方都没有（不是 mock 实例、`AGENT_API_KEY` 与 `XAI_API_KEY` 都没配）时，
   * 必须在**扣款之前**就 503——先扣再退会在流水上留下一对无意义的进出。
   */
  it("refuses before charging when no chat provider is configured", async () => {
    const owner = "usr_0000000000000107";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "没有提供方" });

    const saved = snapshotProviderEnv();
    try {
      clearProviderEnv();
      await expect(
        runTurn(session, { ownerId: owner, text: "生成一张海报" }),
      ).rejects.toMatchObject({ status: 503, code: "agent_unavailable" });
    } finally {
      restoreProviderEnv(saved);
    }

    // 钱一分没动，流水上一条都没有——不是「扣了再退」。
    expect((await readUser(owner))?.balanceCny).toBe(10);
    const { readLedger } = await import("@/lib/billing/ledger");
    expect((await readLedger(owner)).entries).toHaveLength(0);
    // 会话里也不留半轮对话。
    await expect(readSession(owner, session.id)).resolves.toMatchObject({ messages: [] });
  });

  it("rejects the turn before any upstream call when the balance is empty", async () => {
    const owner = "usr_0000000000000105";
    await seedUser(owner, 0);
    const session = await createSession(owner, { title: "没钱" });
    let called = false;

    await expect(
      runTurn(
        session,
        { ownerId: owner, text: "生成海报" },
        {
          complete: async () => {
            called = true;
            return "{}";
          },
        },
      ),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance" });
    expect(called).toBe(false);
  });

  it("B：拒绝提案不建任务、不退轮次费，重放拒绝是幂等的", async () => {
    const owner = "usr_000000000000010b";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "拒绝" });
    const { turn } = await runTurn(
      session,
      { ownerId: owner, text: "来一张图" },
      {
        complete: completerReturning({
          reply: "提案在这。",
          actions: [{ type: "image", prompt: "一张图，保持色板不变" }],
        }),
      },
    );

    const first = await rejectTurn(owner, session.id, turn.id);
    expect(first.turn.status).toBe("rejected");
    expect(first.assistant?.approval).toBe("rejected");
    expect(first.session.jobIds).toEqual([]);

    // 重放拒绝：同一份结果，不炸。
    const again = await rejectTurn(owner, session.id, turn.id);
    expect(again.turn.status).toBe("rejected");

    // 不能再批准：rejected 是终态。
    await expect(approveTurn(owner, session.id, turn.id)).rejects.toMatchObject({ status: 409 });
    // 轮次费照扣（对话已交付），任务钱一分没动。
    expect((await readUser(owner))?.balanceCny).toBe(10 - TURN_PRICE);
  });

  it("B：批准的重复调用幂等——重放交回同一批任务，不再建第二条", async () => {
    const owner = "usr_000000000000010c";
    await seedUser(owner, 100);
    const session = await createSession(owner, { title: "重复批准" });
    const { turn } = await runTurn(
      session,
      { ownerId: owner, text: "一张图" },
      {
        complete: completerReturning({
          reply: "来。",
          actions: [{ type: "image", prompt: "一张图，保持色板不变" }],
        }),
      },
    );

    const first = await approveTurn(owner, session.id, turn.id);
    const jobId = first.assistant?.jobs?.[0].jobId;
    expect(jobId).toBeTruthy();

    const again = await approveTurn(owner, session.id, turn.id);
    expect(again.turn.status).toBe("succeeded");
    expect(again.session.jobIds).toEqual([jobId]);
  });

  it("B：thinking 中的同 turnId 重放接着把 LLM 补跑完，不重复扣款", async () => {
    const owner = "usr_000000000000010d";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "续跑" });
    const turnId = "msg_aabbccddeeff0022";

    // 模拟「第一次请求死在 LLM 中途」：手工把一个 thinking 轮次钉进会话。
    const { updateSession } = await import("./store");
    const { hashTurnRequest } = await import("./run-turn");
    const input = { ownerId: owner, text: "画一张图", turnId };
    await updateSession(owner, session.id, (s) => ({
      ...s,
      turns: [
        ...(s.turns ?? []),
        {
          id: turnId,
          requestHash: hashTurnRequest(input),
          status: "thinking" as const,
          priceCny: TURN_PRICE,
          chargeRef: `agent:${turnId}`,
          jobIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }));

    let calls = 0;
    const res = await runTurn(
      session,
      input,
      {
        complete: async () => {
          calls += 1;
          return JSON.stringify({ reply: "补跑完成。", actions: [] });
        },
      },
    );
    expect(calls).toBe(1);
    expect(res.turn.status).toBe("succeeded");
    // 只补了一条扣款行（ref 幂等），没有第二条。
    const { readLedger } = await import("@/lib/billing/ledger");
    const { entries } = await readLedger(owner);
    expect(entries.filter((e) => e.ref === `agent:${turnId}`)).toHaveLength(1);
  });

  it("B：会话预算见底时轮次费 402 且净额为 0（扣了又退）", async () => {
    const owner = "usr_000000000000010e";
    await seedUser(owner, 100);
    const session = await createSession(owner, { title: "预算" });
    // 上限 0.03 < 轮次费 0.05：这轮根本进不了门。
    await patchSession(owner, session.id, { budgetCny: 0.03 });

    let called = false;
    await expect(
      runTurn(
        session,
        { ownerId: owner, text: "来一张" },
        {
          complete: async () => {
            called = true;
            return JSON.stringify({ reply: "不该走到", actions: [] });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 402, code: "budget_exhausted" });
    expect(called).toBe(false);
    // 扣了即退，余额回到原样。
    expect((await readUser(owner))?.balanceCny).toBe(100);
  });

  it("B：批准前按提案总额核对预算，超了 402 且不建任务", async () => {
    const owner = "usr_000000000000010f";
    await seedUser(owner, 100);
    const session = await createSession(owner, { title: "提案预算" });
    // 轮次费能过、提案过不了：上限 = 轮次费（0.05）+ 比一张图（0.5）少一点。
    await patchSession(owner, session.id, { budgetCny: 0.4 });

    const { turn } = await runTurn(
      session,
      { ownerId: owner, text: "来一张图" },
      {
        complete: completerReturning({
          reply: "提案。",
          actions: [{ type: "image", prompt: "一张图，保持色板不变" }],
        }),
      },
    );
    expect(turn.status).toBe("awaiting_approval");

    await expect(approveTurn(owner, session.id, turn.id)).rejects.toMatchObject({
      status: 402,
      code: "budget_exhausted",
    });
    const stored = await readSession(owner, session.id);
    expect(stored?.jobIds).toEqual([]);
    // 提案还在原状等批——预算调高后还能批。
    expect(stored?.turns?.[0].status).toBe("awaiting_approval");
  });

  it("B：技能能力过滤——只出图的技能丢掉模型给的 video 动作", async () => {
    const owner = "usr_0000000000000110";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "能力过滤", skillId: "ecom-hero" });
    const { turn, assistant } = await runTurn(
      session,
      { ownerId: owner, text: "顺带也来个视频" },
      {
        complete: completerReturning({
          reply: "只出图。",
          actions: [
            { type: "image", prompt: "主图海报，保持色板不变" },
            { type: "video", prompt: "不该出现的视频动作" },
          ],
        }),
      },
    );
    // video 动作被丢：提案只剩那一条图的。
    expect(turn.proposal?.actions).toHaveLength(1);
    expect(turn.proposal?.actions[0].type).toBe("image");
    expect(assistant?.jobs).toHaveLength(1);
  });

  it("B：过期提案拒绝批准（409 proposal_expired）", async () => {
    const owner = "usr_0000000000000111";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "过期" });
    const { turn } = await runTurn(
      session,
      { ownerId: owner, text: "一张图" },
      {
        complete: completerReturning({
          reply: "来。",
          actions: [{ type: "image", prompt: "一张图，保持色板不变" }],
        }),
      },
    );
    // 把提案有效期拨到过去：报价失效，必须重新发一轮。
    const { updateSession } = await import("./store");
    await updateSession(owner, session.id, (s) => ({
      ...s,
      turns: s.turns!.map((x) =>
        x.id === turn.id && x.proposal
          ? { ...x, proposal: { ...x.proposal, expiresAt: new Date(Date.now() - 1000).toISOString() } }
          : x,
      ),
    }));
    await expect(approveTurn(owner, session.id, turn.id)).rejects.toMatchObject({
      status: 409,
      code: "proposal_expired",
    });
  });

  it("B：awaiting_approval 的同参重放交回待批状态，不重扣、不调 LLM", async () => {
    const owner = "usr_0000000000000112";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "重放待批" });
    const turnId = "msg_0011223344556699";
    let calls = 0;
    const input = { ownerId: owner, text: "画一张海报", turnId };
    const first = await runTurn(session, input, {
      complete: async () => {
        calls += 1;
        return JSON.stringify({
          reply: "提案。",
          actions: [{ type: "image", prompt: "海报，保持色板不变" }],
        });
      },
    });
    expect(first.turn.status).toBe("awaiting_approval");

    const again = await runTurn(session, input, {
      complete: completerReturning({ reply: "不该被走到", actions: [] }),
    });
    expect(again.turn.status).toBe("awaiting_approval");
    expect(again.assistant?.approval).toBe("pending");
    expect(calls).toBe(1);
  });

  it("B：readTurn 惰性结算死掉的 thinking 轮次——退款 + failed", async () => {
    const owner = "usr_0000000000000113";
    await seedUser(owner, 10);
    const session = await createSession(owner, { title: "陈旧轮次" });
    const turnId = "msg_00112233445566aa";

    const { updateSession } = await import("./store");
    const { hashTurnRequest } = await import("./run-turn");
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await updateSession(owner, session.id, (s) => ({
      ...s,
      turns: [
        ...(s.turns ?? []),
        {
          id: turnId,
          requestHash: hashTurnRequest({ text: "画一张图" }),
          status: "thinking" as const,
          priceCny: TURN_PRICE,
          chargeRef: `agent:${turnId}`,
          jobIds: [],
          createdAt: old,
          updatedAt: old,
        },
      ],
    }));
    // 手工把「已扣款」的账补上：结算退的是这笔钱。
    const { applyBalanceChange } = await import("@/lib/billing/ledger");
    await applyBalanceChange(owner, -TURN_PRICE, {
      kind: "charge",
      amountCny: -TURN_PRICE,
      ref: `agent:${turnId}`,
      note: "智能体对话",
    });

    const found = await readTurn(owner, session.id, turnId);
    expect(found?.turn.status).toBe("failed");
    expect(found?.turn.refundRef).toBe(`agent:${turnId}:refund`);
    expect((await readUser(owner))?.balanceCny).toBe(10);
  });
});
