import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { JobRecord } from "./schema";

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let readJob: typeof import("./store").readJob;
let retryJob: typeof import("./create").retryJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-create-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createJob, retryJob } = await import("./create"));
  ({ readJob } = await import("./store"));
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
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("createJob upload claims", () => {
  it("removes the sidecar after moving an upload into the job", async () => {
    const uploadId = "up_aaaaaaaaaaaaaaaa";
    const tmp = path.join(dataRoot, "tmp");
    await mkdir(tmp, { recursive: true });
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(path.join(tmp, uploadId), jpeg);
    await writeFile(
      path.join(tmp, `${uploadId}.json`),
      JSON.stringify({
        uploadId,
        ownerId: TEST_OWNER,
        role: "start",
        width: 2,
        height: 2,
        bytes: jpeg.length,
        mimeType: "image/jpeg",
        durationSec: null,
        createdAt: new Date().toISOString(),
      }),
    );

    const { job } = await createJob(
      {
        mode: "image_to_video",
        prompt: "a slow camera move",
        durationSec: 1,
        startUploadId: uploadId,
      },
      TEST_OWNER,
    );

    await expect(access(path.join(tmp, `${uploadId}.json`))).rejects.toThrow();
    await expect(readFile(path.join(dataRoot, "jobs", job.id, "inputs", "start.jpg"))).resolves.toEqual(jpeg);

    for (let i = 0; i < 12; i += 1) {
      const current = await readJob(job.id);
      if (current?.status === "succeeded" || current?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
});

/**
 * Retention deleted the source job's `inputs/` (plan §8), so a one-click retry has
 * nothing to copy. The refusal is checked before the status rule: a purged job is
 * normally `succeeded`, and "仅失败或过期任务可重试" would point at the wrong problem.
 */
describe("retryJob on a purged job", () => {
  function record(over: Partial<JobRecord> = {}): JobRecord {
    return {
      schemaVersion: 1,
      id: "job_purged000001",
      ownerId: TEST_OWNER,
      status: "succeeded",
      progress: 100,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "旧仓库里的一束光",
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
      costUsdActual: 0.02,
      error: null,
      output: { kind: "image", imageUrl: "/api/media/job_purged000001/image.jpg" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:00.000Z",
      artifactsPurgedAt: "2026-09-01T00:00:00.000Z",
      bible: null,
      shots: null,
      assets: {},
      ...over,
    };
  }

  it("answers 409 artifacts_purged and creates nothing", async () => {
    const before = await readdir(path.join(dataRoot, "jobs")).catch(() => [] as string[]);

    await expect(retryJob(record(), TEST_OWNER)).rejects.toMatchObject({
      status: 409,
      code: "artifacts_purged",
      message: "作品已过期清理，请用这条提示词重新生成",
    });

    const after = await readdir(path.join(dataRoot, "jobs")).catch(() => [] as string[]);
    expect(after).toEqual(before);
  });

  it("gives the same answer for a purged failed job, which would otherwise be retryable", async () => {
    const failed = record({
      status: "failed",
      output: null,
      error: { code: "internal", message: "上游炸了" },
    });
    await expect(retryJob(failed, TEST_OWNER)).rejects.toMatchObject({ code: "artifacts_purged" });
  });

  it("still refuses an un-purged succeeded job with the plain status conflict", async () => {
    const intact = record({ artifactsPurgedAt: undefined });
    await expect(retryJob(intact, TEST_OWNER)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
  });
});

/**
 * Balance admission (方案 §3.2): the balance gate runs inside the same
 * `withAdmissionLock` critical section as the quota check, right before a fresh
 * job is written. Each test uses its own owner so one test's reservation cannot
 * be mistaken for another's (mirrors `quota-admission.test.ts`'s `owner(tag)`).
 */
describe("createJob balance admission gate", () => {
  function billingOwner(tag: string): string {
    return `usr_${tag.padStart(16, "0")}`;
  }

  async function seedBalance(id: string, balanceCny: number) {
    const { writeUser } = await import("@/lib/users/store");
    return writeUser({
      id,
      email: `${id}@example.com`,
      passwordHash: "hash",
      sessionEpoch: 1,
      plan: "free",
      balanceCny,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** A non-terminal job written straight to job.json, to model an existing reservation
   * without racing the live (unmocked, in this file) runner to completion. */
  async function seedPendingImage(id: string, ownerId: string, priceCny: number) {
    const { writeJob } = await import("./store");
    const now = new Date().toISOString();
    const rec: JobRecord = {
      schemaVersion: 1,
      id,
      ownerId,
      status: "pending",
      progress: 0,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "在途预留",
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
    return writeJob(rec);
  }

  it("refuses a submission with 402 insufficient_balance when the balance is 0", async () => {
    const id = billingOwner("d1");
    await seedBalance(id, 0);
    await expect(
      createJob({ mode: "text_to_image", prompt: "没钱" } as Parameters<typeof createJob>[0], id),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance" });
  });

  it("admits a submission the balance covers and stamps its priceCny on the record", async () => {
    const id = billingOwner("d2");
    await seedBalance(id, 10);
    const { job } = await createJob(
      { mode: "text_to_image", prompt: "够钱", imageResolution: "1k" } as Parameters<typeof createJob>[0],
      id,
    );
    // Default price table: 1k image = ¥0.5 (billing/prices.ts).
    expect(job.priceCny).toBe(0.5);
  });

  it("counts an in-flight job's price as reserved: a second submission past the remainder is refused", async () => {
    const id = billingOwner("d3");
    await seedBalance(id, 0.5); // exactly one 1k image, nothing left over
    await seedPendingImage("job_balance_reserved", id, 0.5);

    await expect(
      createJob(
        { mode: "text_to_image", prompt: "第二张", imageResolution: "1k" } as Parameters<typeof createJob>[0],
        id,
      ),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance" });
  });
});
