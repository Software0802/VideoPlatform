import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeDurationSec, runFfmpeg } from "@/lib/ffmpeg";
import type { JobRecord } from "@/lib/jobs/schema";
import type { NativeMode, ProviderGenerateRequest, ProviderHandle, VideoProvider } from "@/lib/providers/types";
import { mockDirectorPlan } from "./mock-director";
import type { HarnessPlan } from "./types";

let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;
let createHarnessOrchestrator: typeof import("./orchestrator").createHarnessOrchestrator;
let HarnessFailure: typeof import("./orchestrator").HarnessFailure;
let lockPlan: typeof import("./orchestrator").lockPlan;
let stitchOrder: typeof import("./orchestrator").stitchOrder;
let stitchDimensions: typeof import("./orchestrator").stitchDimensions;

function record(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    schemaVersion: 1,
    id,
    status: "queued",
    progress: 0,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "雨夜的外滩，一位穿深青色风衣的女人走向江边",
    durationSec: 30,
    aspectRatio: "16:9",
    resolution: "720p",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: true },
    priceCny: 0,
    costUsdEstimate: 2.4,
    costUsdActual: null,
    imageResolution: null,
    error: null,
    output: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
}

/** A provider that renders tiny lavfi clips of the requested length into the shot job dir. */
function clipProvider(durationFor: (req: ProviderGenerateRequest) => number): VideoProvider & {
  submit: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn(async (req: ProviderGenerateRequest): Promise<ProviderHandle> => {
    if (req.mode === "image_to_video" && req.startImage?.kind === "path") {
      await access(req.startImage.path);
    }
    const { mediaStore } = await import("@/lib/storage/local-fs");
    const abs = path.join(mediaStore.jobDir(req.jobId), "tmp/video.mp4");
    await mkdir(path.dirname(abs), { recursive: true });
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=64x36:r=12:d=${durationFor(req)}`,
      "-t",
      String(durationFor(req)),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      abs,
    ]);
    return { providerId: "mock", remoteId: req.jobId, localVideoPath: "tmp/video.mp4" };
  });
  return {
    id: "mock",
    capabilities: () => ({
      modes: ["text_to_video", "image_to_video", "text_to_image"],
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    }),
    submit,
    poll: vi.fn(async () => ({ status: "done" as const, progress: 100 })),
  };
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-orchestrator-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob } = await import("@/lib/jobs/store"));
  ({ createHarnessOrchestrator, HarnessFailure, lockPlan, stitchOrder, stitchDimensions } =
    await import("./orchestrator"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("harness orchestrator", () => {
  it("stays closed until HARNESS_ENABLED", async () => {
    await writeJob(record("job_closed"));
    const closed = createHarnessOrchestrator({ enabled: () => false });
    await expect(closed.execute("job_closed")).rejects.toThrow("HARNESS_NOT_ENABLED");
  });

  it("directs, chains tail frames, QCs each shot, stitches, and hands back persisting", async () => {
    const id = "job_harness_ok";
    await writeJob(record(id));
    const provider = clipProvider((req) => req.durationSec ?? 8);
    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      pollIntervalMs: 0,
      stitchSize: () => ({ width: 64, height: 36 }),
    });

    await orchestrator.execute(id);

    const job = await readJob(id);
    expect(job?.status).toBe("persisting");
    expect(job?.localOutputPath).toBe("outputs/video.mp4");
    expect(job?.harnessPlan?.shots).toHaveLength(3);
    expect(job?.harnessShots?.map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(job?.harnessShots?.[0]?.qc).toMatchObject({ durationOk: true, blackFrameFree: true, freezeFree: true });
    // Submit-time estimate is untouched; the plan-derived figure lands beside it (R05).
    expect(job?.costUsdEstimate).toBe(2.4);
    expect(job?.costUsdPlanned).toBe(2.4);
    expect(job?.costIncomplete).toBe(false);
    // Shot 1 is tail-chained: I2V from the sharpest frame of shot 0's tail.
    expect(job?.harnessPlan?.shots[1]).toMatchObject({
      route: "i2v",
      startFrame: { source: "extracted", assetId: "shots/0/tail.jpg" },
    });
    await access(path.join(dataRoot, "jobs", id, "shots", "0", "tail.jpg"));
    expect(provider.submit.mock.calls[1]![0]).toMatchObject({ mode: "image_to_video" });
    const probe = await probeDurationSec(path.join(dataRoot, "jobs", id, "outputs", "video.mp4"));
    expect(probe.durationSec).toBeGreaterThan(29.5);
    expect(probe.durationSec).toBeLessThan(30.6);
    expect(probe.width).toBe(64);
    // The runner treats the stitched file like any other staged output.
    await expect(orchestrator.execute(id)).resolves.toBeUndefined();
    expect((await readJob(id))?.status).toBe("persisting");
  }, 120_000);

  it("retries a shot that fails QC twice and then escalates to needs_review", async () => {
    const id = "job_harness_qc";
    await writeJob(record(id));
    // Every clip comes back 5s short: duration QC rejects it on each attempt.
    const provider = clipProvider((req) => (req.durationSec ?? 8) - 5);
    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      pollIntervalMs: 0,
      shotConcurrency: () => 1,
    });

    await expect(orchestrator.execute(id)).rejects.toBeInstanceOf(HarnessFailure);
    const job = await readJob(id);
    expect(job?.status).toBe("generating_shots");
    const first = job?.harnessShots?.[0];
    expect(first?.status).toBe("needs_review");
    expect(first?.retries).toBe(2);
    expect(first?.error?.message).toContain("qc_duration");
    // shot 1 depends on shot 0 and is blocked, never submitted.
    expect(job?.harnessShots?.[1]?.status).toBe("needs_review");
    expect(job?.harnessShots?.[2]?.status).toBe("needs_review");
    expect(provider.submit).toHaveBeenCalledTimes(3);
    // Retries tighten the prompt with the Bible's locked traits.
    const retried = provider.submit.mock.calls[1]![0] as ProviderGenerateRequest;
    expect(retried.prompt).toContain("严格保持不变");
  }, 120_000);

  it("rejects a plan that cannot fit the budget cap before any shot is submitted (R06)", async () => {
    const id = "job_harness_budget";
    await writeJob(record(id));
    const provider = clipProvider((req) => req.durationSec ?? 8);
    // Submit-time estimate is $2.40; a ×0.4 cap ($0.96) cannot fit the $2.40 plan the
    // Director produced, so the run stops at the plan, not halfway through the shots.
    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      pollIntervalMs: 0,
      budgetMultiplier: 0.4,
    });
    await expect(orchestrator.execute(id)).rejects.toMatchObject({ code: "budget_exceeded" });
    const job = await readJob(id);
    expect(provider.submit).not.toHaveBeenCalled();
    // The plan-derived figure is still recorded for the UI; no shot ever left the queue.
    expect(job?.costUsdPlanned).toBe(2.4);
    expect(job?.harnessShots?.map((s) => s.status)).toEqual(["queued", "queued", "queued"]);
    expect(job?.error ?? null).toBeNull();
  }, 60_000);

  it("resumes an interrupted run from the saved plan without re-directing", async () => {
    const id = "job_harness_resume";
    await writeJob(record(id, { status: "directing" }));
    const director = vi.fn(async (input: Parameters<typeof mockDirectorPlan>[0]) => mockDirectorPlan(input));
    const provider = clipProvider((req) => req.durationSec ?? 8);
    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      director,
      pollIntervalMs: 0,
      stitchSize: () => ({ width: 64, height: 36 }),
    });
    await orchestrator.execute(id);
    expect(director).toHaveBeenCalledTimes(1);

    // Simulate a crash after the plan was saved: reset the status and run again.
    const { updateJob } = await import("@/lib/jobs/store");
    await updateJob(id, (r) => {
      r.status = "directing";
      delete r.localOutputPath;
      return r;
    });
    await orchestrator.execute(id);
    expect(director).toHaveBeenCalledTimes(1);
    expect(provider.submit).toHaveBeenCalledTimes(3);
    expect((await readJob(id))?.status).toBe("persisting");
  }, 120_000);
});

describe("plan locking and stitch order", () => {
  const base: HarnessPlan = mockDirectorPlan({ prompt: "x", targetDurationSec: 30 });

  const caps = { modes: ["text_to_video", "image_to_video", "reference_to_video"] as NativeMode[] };

  it("drops Director frame refs it cannot materialize and routes user frames to I2V", () => {
    const raw: HarnessPlan = {
      ...base,
      shots: base.shots.map((s, i) => ({
        ...s,
        route: "t2v" as const,
        continuity: i === 0 ? ("tail_chain" as const) : s.continuity,
        startFrame: { source: "generated" as const, assetId: "made-up" },
      })),
    };
    const locked = lockPlan(raw, {
      assets: { start: { path: "inputs/start.jpg", width: 1, height: 1 }, last: { path: "inputs/last.jpg", width: 1, height: 1 } },
    }, caps);
    expect(locked.shots[0]).toMatchObject({
      route: "i2v",
      continuity: "hard_cut",
      startFrame: { source: "user", assetId: "inputs/start.jpg" },
    });
    expect(locked.shots[1]).toMatchObject({
      route: "i2v",
      startFrame: { source: "extracted", assetId: "shots/0/tail.jpg" },
    });
    // 用户尾帧锁在最后一镜（现在 30s = 3 镜）。
    expect(locked.shots[2]).toMatchObject({
      endFrame: { source: "user", assetId: "inputs/last.jpg" },
    });
  });

  it("demotes r2v when the provider does not declare reference_to_video", () => {
    const raw: HarnessPlan = {
      ...base,
      shots: base.shots.map((s) => ({ ...s, route: "r2v" as const, characterIds: ["c_main"] })),
    };
    const locked = lockPlan(raw, { assets: {} }, { modes: ["text_to_video", "image_to_video"] as NativeMode[] });
    // 可灵不声明 r2v：tail_chain 镜头落 i2v，首镜硬切落 t2v。
    expect(locked.shots[0]!.route).toBe("t2v");
    expect(locked.shots.slice(1).every((s) => s.route === "i2v")).toBe(true);
  });

  it("stitches every shot clip in index order", () => {
    const plan: HarnessPlan = base;
    const shots = plan.shots.map((s) => ({
      id: s.id,
      index: s.index,
      status: "succeeded" as const,
      retries: 0,
      costUsd: 0,
      outputPath: `shots/${s.index}/video.mp4`,
    }));
    expect(stitchOrder(plan, shots)).toEqual([
      "shots/0/video.mp4",
      "shots/1/video.mp4",
      "shots/2/video.mp4",
    ]);
  });

  it("derives stitch dimensions from aspect ratio and resolution", () => {
    expect(stitchDimensions("16:9", "720p")).toEqual({ width: 1280, height: 720 });
    expect(stitchDimensions("9:16", "720p")).toEqual({ width: 720, height: 1280 });
    expect(stitchDimensions("1:1", "480p")).toEqual({ width: 480, height: 480 });
    expect(stitchDimensions("4:3", "1080p")).toEqual({ width: 1440, height: 1080 });
  });
});
