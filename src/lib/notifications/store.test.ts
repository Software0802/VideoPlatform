import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession, AgentTurnStatus } from "@/lib/agent/schema";
import type { CanvasNodeExecution, CanvasRun } from "@/lib/canvas/schema";
import type { JobRecord } from "@/lib/jobs/schema";

/**
 * `notifications/store.ts` 的落盘纪律（H 包 §2 + §6）：幂等 append、200 条截断、
 * 坏文件换新 epoch 重建、`markRead` 的 epoch 校验与游标不回退、跨用户文件隔离。
 * 与 `jobs/store.test.ts` 同一套 fixture 习惯：`DATA_DIR` 指到临时目录后再动态 import。
 */
let dataRoot = "";
let appendJobNotification: typeof import("./store").appendJobNotification;
let appendRunNotifications: typeof import("./store").appendRunNotifications;
let appendAgentNotifications: typeof import("./store").appendAgentNotifications;
let runNotificationEdges: typeof import("./store").runNotificationEdges;
let agentNotificationEdges: typeof import("./store").agentNotificationEdges;
let markRead: typeof import("./store").markRead;
let notificationPath: typeof import("./store").notificationPath;
let notificationsDir: typeof import("./store").notificationsDir;
let readNotifications: typeof import("./store").readNotifications;
let MAX_NOTIFICATIONS: number;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-notifications-"));
  process.env.DATA_DIR = dataRoot;
  ({
    appendJobNotification,
    appendRunNotifications,
    appendAgentNotifications,
    runNotificationEdges,
    agentNotificationEdges,
    markRead,
    notificationPath,
    notificationsDir,
    readNotifications,
    MAX_NOTIFICATIONS,
  } = await import("./store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

let seq = 0;
function jobFixture(
  ownerId: string | undefined,
  status: JobRecord["status"],
  prompt = "通知测试",
): JobRecord {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_notice_${seq}`,
    ownerId,
    status,
    progress: 100,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt,
    durationSec: 0,
    aspectRatio: "16:9",
    resolution: null,
    imageResolution: "1k",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    priceCny: 0,
    costUsdEstimate: 0.02,
    costUsdActual: null,
    error: status === "succeeded" ? null : { code: "internal", message: "上游炸了" },
    output: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    bible: null,
    shots: null,
    assets: {},
  };
}

function userId(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

function runFixture(
  ownerId: string,
  overrides: Partial<CanvasRun> = {},
  executions: CanvasNodeExecution[] = [{ nodeId: "n_00000001", attempt: 1, status: "ready" }],
): CanvasRun {
  const now = "2026-09-14T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "crun_000000000001",
    ownerId,
    canvasId: "cv_000000000001",
    documentRevision: 0,
    graphSnapshot: { nodes: [], edges: [] },
    quote: { hash: "quote-hash", totalCny: 0, items: [] },
    status: "running",
    nodeExecutions: executions,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function sessionFixture(
  ownerId: string,
  status: AgentTurnStatus,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  const now = "2026-09-14T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "ses_0000000000000001",
    ownerId,
    title: "海报会话",
    messages: [],
    jobIds: [],
    turns: [
      {
        id: "msg_0000000000000001",
        requestHash: "0".repeat(64),
        status,
        priceCny: 0.05,
        chargeRef: "agent:msg_0000000000000001",
        jobIds: [],
        ...(status === "awaiting_approval"
          ? {
              proposal: {
                actions: [{ type: "image", prompt: "海报", priceCny: 0.5 }],
                totalCny: 0.5,
                expiresAt: "2026-09-15T00:00:00.000Z",
              },
            }
          : {}),
        ...(status === "failed"
          ? { error: { code: "agent_upstream_failed", message: "上游失败" } }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("appendJobNotification", () => {
  it("appends a terminal job once — the same jobId:status id is idempotent", async () => {
    const id = userId("a1");
    const job = jobFixture(id, "succeeded");

    await appendJobNotification(job);
    await appendJobNotification(job);
    await appendJobNotification({ ...job }); // 崩溃恢复重推同一终态

    const file = await readNotifications(id);
    expect(file?.items).toHaveLength(1);
    expect(file?.items[0]).toMatchObject({
      id: `${job.id}:succeeded`,
      kind: "job",
      jobId: job.id,
      status: "succeeded",
      seq: 1,
      prompt: "通知测试",
    });
    expect(file?.epoch).toMatch(/^nep_[0-9a-f]{16}$/);
  });

  it("keeps at most MAX_NOTIFICATIONS mixed items, dropping the oldest first", async () => {
    const id = userId("a2");
    for (let i = 0; i < MAX_NOTIFICATIONS - 1; i += 1) {
      await appendJobNotification(jobFixture(id, i % 2 ? "failed" : "succeeded"));
    }
    const beforeRun = runFixture(id);
    const afterRun = runFixture(id, { status: "succeeded", finishedAt: "2026-09-14T00:01:00.000Z" }, [
      { nodeId: "n_00000001", attempt: 1, status: "succeeded" },
    ]);
    await appendRunNotifications(beforeRun, afterRun);
    await appendAgentNotifications(
      sessionFixture(id, "thinking"),
      sessionFixture(id, "failed"),
    );
    const file = await readNotifications(id);
    expect(file?.items).toHaveLength(MAX_NOTIFICATIONS);
    expect(file?.items[0]?.seq).toBe(2);
    expect(file?.items.at(-2)?.kind).toBe("run");
    expect(file?.items.at(-1)?.kind).toBe("agent");
    expect(file?.items.at(-1)?.seq).toBe(MAX_NOTIFICATIONS + 1);
    expect(file?.nextSeq).toBe(MAX_NOTIFICATIONS + 2);
  }, 15_000);

  it("records errorCode/errorMessage for failed jobs and truncates prompt at 120 chars", async () => {
    const id = userId("a3");
    const job = jobFixture(id, "failed", "长".repeat(200));
    await appendJobNotification(job);
    const file = await readNotifications(id);
    const item = file?.items[0];
    expect(item).toMatchObject({
      kind: "job",
      status: "failed",
      errorCode: "internal",
      errorMessage: "上游炸了",
    });
    expect([...(item?.kind === "job" ? item.prompt : "")]).toHaveLength(120);
  });

  it("ignores non-terminal jobs and ownerless records", async () => {
    const id = userId("a4");
    expect(await appendJobNotification(jobFixture(id, "pending"))).toBeNull();
    expect(await appendJobNotification(jobFixture(undefined, "succeeded"))).toBeNull();
    // 上面两条都不该落任何文件：该用户的通知文件不存在。
    const names = await readdir(notificationsDir()).catch(() => [] as string[]);
    expect(names).not.toContain(`${id}.json`);
  });
});

describe("run notifications", () => {
  it("emits terminal and awaiting-approval edges with node counts", () => {
    const owner = userId("e1");
    const before = runFixture(owner, {}, [
      { nodeId: "n_00000001", attempt: 1, status: "running" },
      { nodeId: "n_00000002", attempt: 1, status: "ready" },
      { nodeId: "n_00000003", attempt: 1, status: "waiting_dependencies" },
    ]);
    const terminal = runFixture(owner, { status: "partially_failed", finishedAt: "2026-09-14T00:02:00.000Z" }, [
      { nodeId: "n_00000001", attempt: 1, status: "succeeded" },
      { nodeId: "n_00000002", attempt: 1, status: "failed" },
      { nodeId: "n_00000003", attempt: 1, status: "blocked" },
    ]);
    const terminalItems = [
      expect.objectContaining({
        id: `${terminal.id}:partially_failed`,
        status: "partially_failed",
        nodeCounts: { succeeded: 1, failed: 1, blocked: 1 },
        at: terminal.finishedAt,
      }),
    ];
    expect(runNotificationEdges(before, terminal)).toEqual(terminalItems);
    expect(runNotificationEdges(null, terminal)).toEqual(terminalItems);

    const awaiting = runFixture(owner, { updatedAt: "2026-09-14T00:03:00.000Z" }, [
      { nodeId: "n_00000001", attempt: 1, status: "running" },
      { nodeId: "n_00000002", attempt: 1, status: "awaiting_approval" },
    ]);
    expect(runNotificationEdges(before, awaiting)).toEqual([
      expect.objectContaining({
        id: `${awaiting.id}:n_00000002:awaiting_approval`,
        status: "awaiting_approval",
        nodeId: "n_00000002",
      }),
    ]);
    expect(
      runNotificationEdges(before, { ...awaiting, cancelRequestedAt: "2026-09-14T00:02:30.000Z" }),
    ).toEqual([]);
  });

  it("appends the same before/after edge only once", async () => {
    const owner = userId("e2");
    const before = runFixture(owner);
    const after = runFixture(owner, { status: "succeeded", finishedAt: "2026-09-14T00:04:00.000Z" }, [
      { nodeId: "n_00000001", attempt: 1, status: "succeeded" },
    ]);
    await appendRunNotifications(before, after);
    await appendRunNotifications(before, after);
    expect((await readNotifications(owner))?.items).toHaveLength(1);
  });
});

describe("agent notifications", () => {
  it("emits awaiting and failed edges, but not succeeded or rejected", async () => {
    const owner = userId("f1");
    const before = sessionFixture(owner, "thinking");
    const awaiting = sessionFixture(owner, "awaiting_approval");
    const failed = sessionFixture(owner, "failed");
    expect(agentNotificationEdges(before, awaiting)).toEqual([
      expect.objectContaining({
        id: "msg_0000000000000001:awaiting_approval",
        status: "awaiting_approval",
        totalCny: 0.5,
        actionCount: 1,
      }),
    ]);
    expect(agentNotificationEdges(before, failed)).toEqual([
      expect.objectContaining({
        id: "msg_0000000000000001:failed",
        status: "failed",
        errorCode: "agent_upstream_failed",
        errorMessage: "上游失败",
      }),
    ]);
    expect(agentNotificationEdges(before, sessionFixture(owner, "succeeded"))).toEqual([]);
    expect(agentNotificationEdges(before, sessionFixture(owner, "rejected"))).toEqual([]);

    await appendAgentNotifications(before, awaiting);
    await appendAgentNotifications(before, failed);
    expect((await readNotifications(owner))?.items).toEqual([
      expect.objectContaining({ status: "awaiting_approval" }),
      expect.objectContaining({ status: "failed" }),
    ]);
  });
});

describe("mixed notification files", () => {
  it("parses an old job-only file and appends a run item", async () => {
    const owner = userId("e3");
    const job = jobFixture(owner, "succeeded");
    await writeFile(
      notificationPath(owner),
      JSON.stringify({
        schemaVersion: 1,
        ownerId: owner,
        epoch: "nep_0000000000000001",
        nextSeq: 2,
        lastReadSeq: 0,
        items: [
          {
            seq: 1,
            id: `${job.id}:succeeded`,
            kind: "job",
            jobId: job.id,
            status: "succeeded",
            mode: job.mode,
            prompt: job.prompt,
            at: job.updatedAt,
          },
        ],
      }),
      "utf8",
    );
    const before = runFixture(owner);
    const after = runFixture(owner, { status: "succeeded", finishedAt: "2026-09-14T00:05:00.000Z" }, [
      { nodeId: "n_00000001", attempt: 1, status: "succeeded" },
    ]);
    await appendRunNotifications(before, after);
    const file = await readNotifications(owner);
    expect(file?.items.map((item) => item.kind)).toEqual(["job", "run"]);
  });
});

describe("readNotifications", () => {
  it("creates an empty file with a fresh epoch for a new user", async () => {
    const id = userId("b1");
    const file = await readNotifications(id);
    expect(file).toMatchObject({ ownerId: id, items: [], lastReadSeq: 0, nextSeq: 1 });
    expect(file?.epoch).toMatch(/^nep_/);
  });

  it("rebuilds a corrupt file under a new epoch, invalidating old cursors", async () => {
    const id = userId("b2");
    await appendJobNotification(jobFixture(id, "succeeded"));
    const before = await readNotifications(id);
    expect(before?.items).toHaveLength(1);

    await writeFile(notificationPath(id), "{ 这不是合法 json", "utf8");

    const rebuilt = await readNotifications(id);
    expect(rebuilt?.items).toEqual([]);
    expect(rebuilt?.epoch).not.toBe(before?.epoch);
    expect(rebuilt?.nextSeq).toBe(1);
    // 旧 epoch 的已读请求随即被拒（下一个 describe 覆盖 409 本体）。
    await expect(markRead(id, before!.epoch, 1)).rejects.toMatchObject({
      status: 409,
      code: "notifications_stale",
    });
  });

  it("returns null when the file's ownerId does not match the path (route renders 404)", async () => {
    const id = userId("b3");
    const other = userId("b4");
    // 把「属于别人」的文件塞进这个用户的路径：内容不可信，不能当成本人的返回。
    await writeFile(
      notificationPath(id),
      JSON.stringify({
        schemaVersion: 1,
        ownerId: other,
        epoch: "nep_0000000000000000",
        nextSeq: 1,
        lastReadSeq: 0,
        items: [],
      }),
      "utf8",
    );
    expect(await readNotifications(id)).toBeNull();
  });
});

describe("markRead", () => {
  it("advances lastReadSeq and never moves it backwards", async () => {
    const id = userId("c1");
    await appendJobNotification(jobFixture(id, "succeeded"));
    await appendJobNotification(jobFixture(id, "succeeded"));
    await appendJobNotification(jobFixture(id, "failed"));
    const file = await readNotifications(id);
    const epoch = file!.epoch;

    const marked = await markRead(id, epoch, 2);
    expect(marked.lastReadSeq).toBe(2);

    // 更小的 upToSeq 不回退游标。
    const again = await markRead(id, epoch, 1);
    expect(again.lastReadSeq).toBe(2);

    // 超过已分配 seq 的游标被夹到 nextSeq-1。
    const clamped = await markRead(id, epoch, 9999);
    expect(clamped.lastReadSeq).toBe(3);
  });

  it("rejects a stale epoch with 409 notifications_stale", async () => {
    const id = userId("c2");
    await readNotifications(id); // 建档
    await expect(markRead(id, "nep_ffffffffffffffff", 0)).rejects.toMatchObject({
      status: 409,
      code: "notifications_stale",
    });
  });
});

describe("per-user isolation", () => {
  it("keeps each user's file independent", async () => {
    const a = userId("d1");
    const b = userId("d2");
    await appendJobNotification(jobFixture(a, "succeeded"));
    await appendJobNotification(jobFixture(a, "succeeded"));
    await appendJobNotification(jobFixture(b, "failed"));

    const fa = await readNotifications(a);
    const fb = await readNotifications(b);
    expect(fa?.items).toHaveLength(2);
    expect(fb?.items).toHaveLength(1);
    expect(fa?.epoch).not.toBe(fb?.epoch);

    const marked = await markRead(a, fa!.epoch, 99);
    expect(marked.lastReadSeq).toBe(2);
    const fbAfter = await readNotifications(b);
    expect(fbAfter?.lastReadSeq).toBe(0);
  });
});
