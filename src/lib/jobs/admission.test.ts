import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "./schema";

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let createJob: (
  body: {
    mode: "text_to_image";
    prompt: string;
    idempotencyKey?: string;
  },
  ownerId: string,
) => Promise<{ job: { id: string }; replay: boolean }>;
let activeCount: () => Promise<number>;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admission-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  process.env.MAX_QUEUED_JOBS = "1";
  ({ createJob } = await import("./create"));
  ({ activeCount } = await import("./runner"));
  // 余额模型（方案 §3.2）：提交与重试都要先过余额判定，先把测试账号建出来并充够。
  const { writeUser } = await import("@/lib/users/store");
  await writeUser({
    id: TEST_OWNER,
    email: "owner@example.com",
    passwordHash: "scrypt$16384$8$1$00$00",
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await waitForIdle();
  await rm(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  delete process.env.MAX_QUEUED_JOBS;
});

async function waitForIdle() {
  for (let i = 0; i < 30; i += 1) {
    if ((await activeCount?.()) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("job admission", () => {
  it("admits at most the configured number of concurrent jobs", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createJob({ mode: "text_to_image", prompt: "one" }, TEST_OWNER)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    await waitForIdle();
  });

  it("replays one job for concurrent requests with the same idempotency key", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createJob({ mode: "text_to_image", prompt: "same", idempotencyKey: "same-key" }, TEST_OWNER),
      ),
    );

    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => result.replay)).toHaveLength(7);
  });
});

/**
 * 方案 §3.3（P2）：`activeCount`（全站，`runner.ts`）、`activeCountForUser`（`jobs/active.ts`，
 * 已经改读 `listJobIndex`）与 `loadBalanceUsage`（`billing/admission.ts`，同样已经改读索引）
 * 三个准入判据都要「结果与全量扫一致」。这里绕开 `createJob`（本文件顶部把
 * `MAX_QUEUED_JOBS` 钉成了 1，走 `createJob` 会立刻撞上面两个用例的并发上限），直接用
 * `writeJob` / `updateJob` 摆数据，跟「独立算出来的期望值」比——尤其是「状态原地变更、
 * 不新建目录」这一种：这正是索引最容易读到旧值的地方（新增/删除会改变目录名集合，
 * `jobs/index.ts` 的 `sameKeys` 校验能自愈；原地状态变更不会）。
 */
describe("activeCount / activeCountForUser / loadBalanceUsage agree with a full scan", () => {
  const OWNER_A = "usr_00000000000000c1";
  const OWNER_B = "usr_00000000000000c2";

  let writeJob: typeof import("./store").writeJob;
  let updateJob: typeof import("./store").updateJob;
  let activeCountForUser: typeof import("./active").activeCountForUser;
  let loadBalanceUsage: typeof import("@/lib/billing/admission").loadBalanceUsage;

  beforeAll(async () => {
    // Drain whatever the two describe blocks above this one left running in the
    // background, so activeCount() (a global, cross-owner count) starts at a known 0.
    await waitForIdle();
    ({ writeJob, updateJob } = await import("./store"));
    ({ activeCountForUser } = await import("./active"));
    ({ loadBalanceUsage } = await import("@/lib/billing/admission"));
    const { writeUser } = await import("@/lib/users/store");
    for (const id of [OWNER_A, OWNER_B]) {
      await writeUser({
        id,
        email: `${id}@example.com`,
        passwordHash: "hash",
        sessionEpoch: 1,
        plan: "free",
        balanceCny: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  });

  let seq = 0;
  function pendingImage(ownerId: string, priceCny: number): JobRecord {
    seq += 1;
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      id: `job_admission_idx_${seq}`,
      ownerId,
      status: "pending",
      progress: 10,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "索引一致性",
      durationSec: 0,
      aspectRatio: "16:9",
      resolution: null,
      imageResolution: "1k",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      priceCny,
      costUsdEstimate: 0.02,
      costUsdActual: null,
      error: null,
      output: null,
      createdAt: now,
      updatedAt: now,
      bible: null,
      shots: null,
      assets: {},
    };
  }

  it("counts only the non-terminal jobs actually written, split correctly by owner", async () => {
    const a1 = await writeJob(pendingImage(OWNER_A, 1.5));
    const a2 = await writeJob(pendingImage(OWNER_A, 2.5));
    // Terminal from the start: must not be counted as active or reserved anywhere.
    await writeJob({
      ...pendingImage(OWNER_B, 9),
      status: "succeeded",
      output: { kind: "image", imageUrl: "/x.jpg" },
    });

    expect(await activeCount()).toBe(2);
    expect(await activeCountForUser(OWNER_A)).toBe(2);
    expect(await activeCountForUser(OWNER_B)).toBe(0);

    const usageA = await loadBalanceUsage(OWNER_A);
    expect(usageA.reservedCny).toBe(4); // 1.5 + 2.5
    expect(usageA.availableCny).toBe(usageA.balanceCny - 4);
    expect((await loadBalanceUsage(OWNER_B)).reservedCny).toBe(0);

    // Clean up so later assertions in this describe block start from a known baseline.
    await updateJob(a1.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      return r;
    });
    await updateJob(a2.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      return r;
    });
    expect(await activeCount()).toBe(0);
  });

  it("reflects a status change made in place via updateJob, without a new job directory ever being created", async () => {
    const job = await writeJob(pendingImage(OWNER_A, 3));
    expect(await activeCountForUser(OWNER_A)).toBe(1);
    expect((await loadBalanceUsage(OWNER_A)).reservedCny).toBe(3);

    await updateJob(job.id, (r) => {
      r.status = "succeeded";
      r.output = { kind: "image", imageUrl: `/api/media/${job.id}/image.jpg` };
      return r;
    });

    // Same directory throughout (writeJob -> updateJob on the same id): if updateJob
    // did not also maintain data/jobs/index.json, this would still read the stale
    // "pending" entry and both numbers below would be wrong.
    expect(await activeCount()).toBe(0);
    expect(await activeCountForUser(OWNER_A)).toBe(0);
    expect((await loadBalanceUsage(OWNER_A)).reservedCny).toBe(0);
  });
});
