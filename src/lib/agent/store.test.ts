import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SESSIONS_PER_USER, type AgentMessage } from "./schema";

/**
 * 会话存储（方案 §1）：归属隔离、上限、追加与列表排序。
 *
 * 归属那一条是这里最要紧的：会话文件按 `data/agent/<userId>/` 分目录，别人的 id
 * 根本拼不出路径；读回来还要再核一次 `ownerId`，手改过的文件也越不了权。
 */

const A = "usr_00000000000000a1";
const B = "usr_00000000000000b2";

let dataRoot = "";
let store: typeof import("./store");

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-agent-store-test-"));
  process.env.DATA_DIR = dataRoot;
  store = await import("./store");
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function message(role: AgentMessage["role"], text: string): AgentMessage {
  return { id: store.newMessageId(), role, text, at: new Date().toISOString() };
}

describe("agent session store", () => {
  it("round-trips a session and keeps it out of another user's reach", async () => {
    const created = await store.createSession(A, { title: "海边黄昏" });
    expect(created.id).toMatch(/^ses_[0-9a-f]{16}$/);

    await expect(store.readSession(A, created.id)).resolves.toMatchObject({ title: "海边黄昏" });
    // 非本人 = 不存在，同一个返回值，不泄露这条 id 真实存在。
    await expect(store.readSession(B, created.id)).resolves.toBeNull();
    await expect(store.readSession(A, "ses_not-an-id")).resolves.toBeNull();
  });

  it("refuses to read a file whose ownerId was tampered with", async () => {
    const created = await store.createSession(A, { title: "改过的文件" });
    // 把 B 的 id 写进 A 目录下的文件：路径守不住的那一半由记录里的 ownerId 守。
    await writeFile(
      store.agentSessionPath(A, created.id),
      JSON.stringify({ ...created, ownerId: B }),
      "utf8",
    );
    await expect(store.readSession(A, created.id)).resolves.toBeNull();
  });

  it("appends a turn onto the freshest copy and records the job ids", async () => {
    const created = await store.createSession(A, { title: "追加" });
    const next = await store.appendTurn(
      A,
      created.id,
      [message("user", "生成一张海报"), message("assistant", "好的")],
      ["job_aaaaaaaaaaaa"],
      { tier: "quality" },
    );
    expect(next?.messages).toHaveLength(2);
    expect(next?.jobIds).toEqual(["job_aaaaaaaaaaaa"]);
    expect(next?.tier).toBe("quality");

    // 同一条任务 id 再来一次不会重复挂上去。
    const again = await store.appendTurn(A, created.id, [message("user", "再来")], ["job_aaaaaaaaaaaa"]);
    expect(again?.messages).toHaveLength(3);
    expect(again?.jobIds).toEqual(["job_aaaaaaaaaaaa"]);
  });

  it("returns null when appending to a session that is gone", async () => {
    const created = await store.createSession(A, { title: "会被删掉" });
    await expect(store.deleteSession(A, created.id)).resolves.toBe(true);
    await expect(store.appendTurn(A, created.id, [message("user", "x")], [])).resolves.toBeNull();
    // 别人删不掉，也不该从「删不掉」里看出这条存在过。
    await expect(store.deleteSession(B, created.id)).resolves.toBe(false);
  });

  it("lists newest first", async () => {
    const owner = "usr_00000000000000c3";
    const first = await store.createSession(owner, { title: "旧" });
    const second = await store.createSession(owner, { title: "新" });
    // `createSession` 在同一毫秒里可能给出一样的 updatedAt，明确把第二条推后一点。
    await store.patchSession(owner, second.id, { title: "新" });
    const list = await store.listSessions(owner);
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(list[0]).not.toHaveProperty("messages");
  });

  it("refuses to open session 201", async () => {
    const owner = "usr_00000000000000d4";
    const dir = store.agentUserDir(owner);
    await mkdir(dir, { recursive: true });
    // 只有文件名参与上限判定，内容不必是完整会话。
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i += 1) {
      await writeFile(path.join(dir, `ses_${i.toString(16).padStart(16, "0")}.json`), "{}", "utf8");
    }
    await expect(store.createSession(owner, { title: "第 201 个" })).rejects.toMatchObject({
      status: 409,
      code: "too_many_sessions",
    });
  });
});
