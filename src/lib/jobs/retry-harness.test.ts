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

    const next = await retryJob(source);
    const retried = await readJob(next.id);
    expect(retried?.status).toBe("queued");
    expect(retried?.harnessPlan).toEqual(plan);
    expect(retried?.harnessShots?.map((s) => s.status)).toEqual(["succeeded", "queued"]);
    expect(retried?.harnessShots?.[1]).toMatchObject({ retries: 0, costUsd: 0 });
    expect(retried?.harnessShots?.[1]?.error).toBeUndefined();
    // Only the kept shot's money carries over; the reviewed shot's spend stays on the old job.
    expect(retried?.costUsdActual).toBe(1.2);
    expect(retried?.costUsdEstimate).toBe(2.1);
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

    await expect(retryJob(source)).rejects.toMatchObject({ status: 500, code: "retry_copy_failed" });
    await expect(retryJob(source)).rejects.toBeInstanceOf(ProviderHttpError);

    // Nothing new was enqueued and the half-built job dir was removed again.
    expect((await readdir(path.join(dataRoot, "jobs"))).sort()).toEqual(before);
  });
});
