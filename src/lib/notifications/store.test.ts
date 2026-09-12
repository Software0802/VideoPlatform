import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "@/lib/jobs/schema";

/**
 * `notifications/store.ts` 的落盘纪律（H 包 §2 + §6）：幂等 append、200 条截断、
 * 坏文件换新 epoch 重建、`markRead` 的 epoch 校验与游标不回退、跨用户文件隔离。
 * 与 `jobs/store.test.ts` 同一套 fixture 习惯：`DATA_DIR` 指到临时目录后再动态 import。
 */
let dataRoot = "";
let appendJobNotification: typeof import("./store").appendJobNotification;
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

  it("keeps at most MAX_NOTIFICATIONS items, dropping the oldest first", async () => {
    const id = userId("a2");
    for (let i = 0; i < MAX_NOTIFICATIONS + 1; i += 1) {
      await appendJobNotification(jobFixture(id, i % 2 ? "failed" : "succeeded"));
    }
    const file = await readNotifications(id);
    expect(file?.items).toHaveLength(MAX_NOTIFICATIONS);
    // 最旧的那条（seq 1）已被截掉；seq 单调递增不回退。
    expect(file?.items[0]?.seq).toBe(2);
    expect(file?.items.at(-1)?.seq).toBe(MAX_NOTIFICATIONS + 1);
    expect(file?.nextSeq).toBe(MAX_NOTIFICATIONS + 2);
  });

  it("records errorCode/errorMessage for failed jobs and truncates prompt at 120 chars", async () => {
    const id = userId("a3");
    const job = jobFixture(id, "failed", "长".repeat(200));
    await appendJobNotification(job);
    const file = await readNotifications(id);
    expect(file?.items[0]).toMatchObject({
      status: "failed",
      errorCode: "internal",
      errorMessage: "上游炸了",
    });
    expect([...(file?.items[0]?.prompt ?? "")]).toHaveLength(120);
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
