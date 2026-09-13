import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mockDirectorPlan } from "@/lib/harness/mock-director";
import { createShotRecords } from "@/lib/harness/shot-state";
import { ProviderHttpError } from "@/lib/providers/types";
import type { JobRecord } from "./schema";

// Keep the in-process runner out of this test: retryJob enqueues, and a live pump would
// start executing the fresh job against whatever HARNESS_ENABLED happens to be.
vi.mock("@/lib/jobs/runner", () => ({ enqueue: vi.fn(), activeCount: async () => 0 }));

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;
let retryJob: typeof import("./create").retryJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-retry-harness-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob } = await import("./store"));
  ({ retryJob } = await import("./create"));
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

describe("retryJob on a harness job (review R09)", () => {
  it("keeps the plan and succeeded shots, re-queuing only the reviewed ones", async () => {
    const plan = mockDirectorPlan({ prompt: "山谷薄雾", targetDurationSec: 30 });
    const shots = createShotRecords(plan.shots);
    const source: JobRecord = {
      schemaVersion: 1,
      id: "job_src",
      status: "failed",
      progress: 40,
      mode: "text_to_video",
      model: "grok-imagine-video-1.5",
      provider: "mock",
      prompt: "山谷薄雾",
      durationSec: 30,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: true },
      priceCny: 0,
      costUsdEstimate: 2.1,
      costUsdPlanned: 2.4,
      costUsdActual: 1.2,
      imageResolution: null,
      error: { code: "needs_review", message: "镜头 2/2 需要人工复核" },
      output: null,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
      bible: null,
      shots: null,
      assets: {},
      harnessPlan: plan,
      harnessShots: [
        { ...shots[0]!, status: "succeeded", outputPath: "shots/0/video.mp4", costUsd: 1.2 },
        { ...shots[1]!, status: "needs_review", retries: 2, costUsd: 0.7, error: { code: "retry_exhausted", message: "x" } },
      ],
    };
    await writeJob(source);
    await mkdir(path.join(dataRoot, "jobs", "job_src", "shots", "0"), { recursive: true });
    await writeFile(path.join(dataRoot, "jobs", "job_src", "shots", "0", "video.mp4"), "clip");
    await writeFile(path.join(dataRoot, "jobs", "job_src", "shots", "0", "tail.jpg"), "tail");

    const next = await retryJob(source, TEST_OWNER);
    const retried = await readJob(next.id);
    expect(retried?.status).toBe("queued");
    expect(retried?.harnessPlan).toEqual(plan);
    expect(retried?.harnessShots?.map((s) => s.status)).toEqual(["succeeded", "queued"]);
    expect(retried?.harnessShots?.[1]).toMatchObject({ retries: 0, costUsd: 0 });
    expect(retried?.harnessShots?.[1]?.error).toBeUndefined();
    // Only the kept shot's money carries over; the reviewed shot's spend stays on the old job.
    expect(retried?.costUsdActual).toBe(1.2);
    // The estimate is re-priced for the provider the retry routed to (mock here), not copied.
    const { estimateHarnessCostUsd } = await import("@/lib/cost");
    const { packHarnessDuration } = await import("@/lib/harness/pack-duration");
    expect(retried?.costUsdEstimate).toBe(
      estimateHarnessCostUsd(packHarnessDuration(30), {
        model: retried!.model,
        video: { resolution: "720p", audio: "off", provider: "mock" },
      }),
    );
    expect(retried?.costUsdPlanned).toBe(2.4);
    await access(path.join(dataRoot, "jobs", next.id, "shots", "0", "video.mp4"));
    await access(path.join(dataRoot, "jobs", next.id, "shots", "0", "tail.jpg"));
    expect(next.shots?.map((s) => s.status)).toEqual(["succeeded", "queued"]);
  });

  it("refuses to create the retry when a kept shot's clip cannot be copied (Codex review #3)", async () => {
    // The kept shot is booked as paid and finished; if its clip does not make it into the new
    // job dir the ledger and the files disagree, so the retry must fail closed instead of
    // enqueueing a job that can only break at stitch time.
    const plan = mockDirectorPlan({ prompt: "山谷薄雾", targetDurationSec: 30 });
    const shots = createShotRecords(plan.shots);
    const source: JobRecord = {
      schemaVersion: 1,
      id: "job_src_missing_clip",
      status: "failed",
      progress: 40,
      mode: "text_to_video",
      model: "grok-imagine-video-1.5",
      provider: "mock",
      prompt: "山谷薄雾",
      durationSec: 30,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: true },
      priceCny: 0,
      costUsdEstimate: 2.1,
      costUsdPlanned: 2.4,
      costUsdActual: 1.2,
      imageResolution: null,
      error: { code: "needs_review", message: "镜头 2/2 需要人工复核" },
      output: null,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
      bible: null,
      shots: null,
      assets: {},
      harnessPlan: plan,
      harnessShots: [
        // Claims a finished clip that was never written (or has since been swept).
        { ...shots[0]!, status: "succeeded", outputPath: "shots/0/video.mp4", costUsd: 1.2 },
        { ...shots[1]!, status: "needs_review", retries: 2, costUsd: 0.7, error: { code: "retry_exhausted", message: "x" } },
      ],
    };
    await writeJob(source);
    const before = (await readdir(path.join(dataRoot, "jobs"))).sort();

    await expect(retryJob(source, TEST_OWNER)).rejects.toMatchObject({ status: 500, code: "retry_copy_failed" });
    await expect(retryJob(source, TEST_OWNER)).rejects.toBeInstanceOf(ProviderHttpError);

    // Nothing new was enqueued and the half-built job dir was removed again.
    expect((await readdir(path.join(dataRoot, "jobs"))).sort()).toEqual(before);
  });

  it("keeps a 30s harness job at 30s (and re-prices it) when the retry lands on Kling", async () => {
    // Regression: retry used to pass the 30s target into providerSettingsFor, where Kling's
    // duration ladder normalized it to 10s — the record then read as a plain 10s clip while
    // still carrying the harness flag. Resolution/audio/ratio still normalize (480p → 720p).
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    try {
      const plan = mockDirectorPlan({ prompt: "山谷薄雾", targetDurationSec: 30 });
      const shots = createShotRecords(plan.shots);
      const source: JobRecord = {
        schemaVersion: 1,
        id: "job_src_kling_retry",
        status: "failed",
        progress: 40,
        mode: "text_to_video",
        model: "mock-video",
        provider: "mock",
        prompt: "山谷薄雾",
        durationSec: 30,
        aspectRatio: "16:9",
        resolution: "480p",
        generateAudio: false,
        lastFrameStored: false,
        lastFrameLocksOutput: false,
        harness: { enabled: true },
        priceCny: 0,
        costUsdEstimate: 2.1,
        costUsdPlanned: 2.4,
        costUsdActual: 1.2,
        imageResolution: null,
        error: { code: "failed", message: "upstream failed" },
        output: null,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
        bible: null,
        shots: null,
        assets: {},
        harnessPlan: plan,
        harnessShots: [
          { ...shots[0]!, status: "succeeded", outputPath: "shots/0/video.mp4", costUsd: 1.2 },
          { ...shots[1]!, status: "failed", retries: 0, costUsd: 0.7, error: { code: "failed", message: "x" } },
        ],
      };
      await writeJob(source);
      await mkdir(path.join(dataRoot, "jobs", "job_src_kling_retry", "shots", "0"), { recursive: true });
      await writeFile(path.join(dataRoot, "jobs", "job_src_kling_retry", "shots", "0", "video.mp4"), "clip");
      await writeFile(path.join(dataRoot, "jobs", "job_src_kling_retry", "shots", "0", "tail.jpg"), "tail");

      const next = await retryJob(source, TEST_OWNER);
      const retried = await readJob(next.id);
      expect(retried?.provider).toBe("kling");
      expect(retried?.harness?.enabled).toBe(true);
      expect(retried?.durationSec).toBe(30);
      expect(retried?.resolution).toBe("720p"); // normalized up to a tier Kling can serve
      expect(retried?.costUsdEstimate).not.toBe(2.1); // re-priced for Kling, not copied
      expect(retried?.costUsdEstimate).toBeGreaterThan(0);
    } finally {
      delete process.env.VIDEO_PROVIDER_ORDER;
      delete process.env.KLING_API_KEY;
      process.env.LUMEN_FORCE_MOCK = "1";
    }
  });
});
