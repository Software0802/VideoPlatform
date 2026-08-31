import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "@/lib/jobs/schema";
import type { HarnessShotStatus, ShotPatch } from "./shot-state";
import type { HarnessPlan } from "./types";

let saveHarnessPlan: (jobId: string, plan: HarnessPlan) => Promise<JobRecord>;
let retryHarnessShot: (jobId: string, shotId: string, maxRetries?: number) => Promise<JobRecord>;
let recoverPersistedShots: (jobId: string) => Promise<JobRecord>;
let updateHarnessShot: (
  jobId: string,
  shotId: string,
  to: HarnessShotStatus,
  patch?: ShotPatch,
) => Promise<JobRecord>;
let toPublic: (record: JobRecord) => { shots: unknown };
let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;

const plan: HarnessPlan = {
  targetDurationSec: 30,
  packing: {
    clips: [
      { kind: "generate", durationSec: 15 },
      { kind: "generate", durationSec: 15 },
    ],
  },
  bible: {
    version: 1,
    logline: "雨夜电影院",
    style: {
      palette: ["amber"],
      lighting: "tungsten",
      lens: "35mm",
      era: "now",
      doNotChange: ["identity"],
    },
    characters: [],
    locations: [],
    props: [],
  },
  shots: [
    {
      id: "shot_0",
      index: 0,
      durationSec: 15,
      prompt: "走进电影院",
      characterIds: [],
      route: "grok_t2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
    {
      id: "shot_1",
      index: 1,
      durationSec: 15,
      prompt: "停在银幕前",
      characterIds: [],
      route: "grok_i2v",
      continuity: "tail_chain",
      generateAudio: false,
    },
  ],
  stitch: { transition: "hard_cut", settleLastFrame: false },
};

function baseRecord(id: string): JobRecord {
  return {
    schemaVersion: 1,
    id,
    status: "queued",
    progress: 0,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "fixture",
    durationSec: 8,
    aspectRatio: "16:9",
    resolution: "720p",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    costUsdEstimate: 0.64,
    costUsdActual: null,
    imageResolution: null,
    error: null,
    output: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    bible: null,
    shots: null,
    assets: {},
  };
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-harness-state-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob, toPublic } = await import("@/lib/jobs/store"));
  ({ saveHarnessPlan, retryHarnessShot, updateHarnessShot, recoverPersistedShots } = await import("./state"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("harness state persistence", () => {
  it("persists a plan and shot records without changing the phase-1 public DTO", async () => {
    const id = "job_harness_state_plan";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);

    const disk = await readJob(id);
    expect(disk?.harnessPlan?.targetDurationSec).toBe(30);
    expect(disk?.harnessShots).toEqual([
      expect.objectContaining({ id: "shot_0", status: "queued", retries: 0, costUsd: 0 }),
      expect.objectContaining({ id: "shot_1", status: "queued", retries: 0, costUsd: 0 }),
    ]);
    expect(toPublic(disk!).shots).toBeNull();
    const raw = await readFile(path.join(dataRoot, "jobs", id, "job.json"), "utf8");
    expect(JSON.parse(raw).harnessPlan.targetDurationSec).toBe(30);
  });

  it("atomically persists shot transitions and refuses unknown shots", async () => {
    const id = "job_harness_state_transition";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    await updateHarnessShot(id, "shot_0", "submitting");
    await updateHarnessShot(id, "shot_0", "pending");
    await updateHarnessShot(id, "shot_0", "persisting");
    await updateHarnessShot(id, "shot_0", "succeeded", {
      outputPath: "shots/0/video.mp4",
      costUsd: 1.2,
    });

    const disk = await readJob(id);
    expect(disk?.harnessShots?.[0]).toMatchObject({
      id: "shot_0",
      status: "succeeded",
      outputPath: "shots/0/video.mp4",
      costUsd: 1.2,
    });
    await saveHarnessPlan(id, plan);
    expect((await readJob(id))?.harnessShots?.[0]?.status).toBe("succeeded");
    await expect(updateHarnessShot(id, "missing", "submitting")).rejects.toThrow("shot 不存在");
  });

  it("persists failed-shot retry transitions and clears stale execution fields", async () => {
    const id = "job_harness_state_retry";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    await updateHarnessShot(id, "shot_0", "submitting");
    await updateHarnessShot(id, "shot_0", "failed", {
      remoteId: "remote-failed",
      outputPath: "shots/0/failed.mp4",
      costUsd: 0.8,
      error: { code: "failed", message: "fixture" },
    });
    await retryHarnessShot(id, "shot_0");

    const disk = await readJob(id);
    expect(disk?.harnessShots?.[0]).toMatchObject({ status: "queued", retries: 1, costUsd: 0.8 });
    expect(disk?.harnessShots?.[0]?.remoteId).toBeUndefined();
    expect(disk?.harnessShots?.[0]?.outputPath).toBeUndefined();
  });

  it("recovers in-flight shots without resetting succeeded clips", async () => {
    const id = "job_harness_state_recover";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    await updateHarnessShot(id, "shot_0", "submitting");
    await updateHarnessShot(id, "shot_0", "pending");
    await updateHarnessShot(id, "shot_0", "persisting");
    await updateHarnessShot(id, "shot_0", "succeeded", { outputPath: "shots/0/video.mp4" });
    await updateHarnessShot(id, "shot_1", "submitting");

    const recovered = await recoverPersistedShots(id);
    expect(recovered.harnessShots?.[0]).toMatchObject({
      status: "succeeded",
      outputPath: "shots/0/video.mp4",
    });
    expect(recovered.harnessShots?.[1]).toMatchObject({ status: "queued", id: "shot_1" });
    expect(recovered.harnessShots?.[1]?.remoteId).toBeUndefined();
  });
});
