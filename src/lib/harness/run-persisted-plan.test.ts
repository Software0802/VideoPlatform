import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderHandle, VideoProvider } from "@/lib/providers/types";
import type { JobRecord } from "@/lib/jobs/schema";
import type { HarnessPlan, Shot } from "./types";

let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;
let saveHarnessPlan: (jobId: string, plan: HarnessPlan) => Promise<JobRecord>;
let runPersistedPlan: (jobId: string, options: {
  maxParallel: number;
  provider?: VideoProvider;
  resolveAsset: (assetId: string) => { kind: "data_uri"; dataUri: string };
  persistOutput: (shot: Shot, handle: ProviderHandle) => Promise<string>;
  pollIntervalMs?: number;
}) => Promise<JobRecord>;

const plan: HarnessPlan = {
  targetDurationSec: 30,
  packing: { clips: [
    { kind: "generate", durationSec: 15 },
    { kind: "generate", durationSec: 15 },
  ] },
  bible: {
    version: 1,
    logline: "fixture",
    style: { palette: ["amber"], lighting: "soft", lens: "35mm", era: "now", doNotChange: [] },
    characters: [],
    locations: [],
    props: [],
  },
  shots: [
    {
      id: "shot_0",
      index: 0,
      durationSec: 15,
      prompt: "第一镜",
      characterIds: [],
      route: "grok_t2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
    {
      id: "shot_1",
      index: 1,
      durationSec: 15,
      prompt: "第二镜",
      characterIds: [],
      route: "grok_t2v",
      continuity: "hard_cut",
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
    priceCny: 0,
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
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-persisted-plan-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob } = await import("@/lib/jobs/store"));
  ({ saveHarnessPlan } = await import("./state"));
  ({ runPersistedPlan } = await import("./run-persisted-plan"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("persisted shot plan", () => {
  it("runs independent shots concurrently and skips them after restart", async () => {
    const id = "job_persisted_plan";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    const submit = vi.fn(async (): Promise<ProviderHandle> => ({
      providerId: "mock",
      localVideoPath: "tmp/video.mp4",
    }));
    const provider: VideoProvider = {
      id: "mock",
      capabilities: () => ({
        modes: ["text_to_video"],
        maxDurationSec: 15,
        supportsLastFrameLock: false,
        maxResolution: "1080p",
      }),
      submit,
      poll: vi.fn(),
    };
    const persistOutput = vi.fn(async (shot: Shot) => {
      const output = path.join(dataRoot, "jobs", id, "shots", String(shot.index), "video.mp4");
      await mkdir(path.dirname(output), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, Buffer.from(`clip-${shot.index}`));
      return `shots/${shot.index}/video.mp4`;
    });
    const options = {
      maxParallel: 2,
      provider,
      resolveAsset: (assetId: string) => ({ kind: "data_uri" as const, dataUri: assetId }),
      persistOutput,
      pollIntervalMs: 0,
    };

    await runPersistedPlan(id, options);
    const first = await readJob(id);
    expect(first?.harnessShots?.map((shot) => shot.status)).toEqual(["succeeded", "succeeded"]);
    expect(submit).toHaveBeenCalledTimes(2);

    await runPersistedPlan(id, options);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(persistOutput).toHaveBeenCalledTimes(2);
    await expect(readFile(path.join(dataRoot, "jobs", id, "shots", "0", "video.mp4"))).resolves.toEqual(
      Buffer.from("clip-0"),
    );
  });

  it("escalates a crashed submitting shot and resumes a pending remote shot", async () => {
    const id = "job_persisted_plan_recover";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    const { updateHarnessShot } = await import("./state");
    await updateHarnessShot(id, "shot_0", "submitting");
    await updateHarnessShot(id, "shot_1", "submitting");
    await updateHarnessShot(id, "shot_1", "pending", { remoteId: "remote-shot-1" });

    const submit = vi.fn(async (): Promise<ProviderHandle> => ({
      providerId: "mock",
      remoteId: "remote-new",
    }));
    const poll = vi.fn<VideoProvider["poll"]>().mockResolvedValue({
      status: "done",
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
    });
    const persistOutput = vi.fn(async (shot: Shot) => `shots/${shot.index}/video.mp4`);
    await runPersistedPlan(id, {
      maxParallel: 2,
      provider: {
        id: "mock",
        capabilities: () => ({
          modes: ["text_to_video"],
          maxDurationSec: 15,
          supportsLastFrameLock: false,
          maxResolution: "1080p",
        }),
        submit,
        poll,
      },
      resolveAsset: (assetId: string) => ({ kind: "data_uri" as const, dataUri: assetId }),
      persistOutput,
      pollIntervalMs: 0,
    });

    const final = await readJob(id);
    // shot_0 died inside the submit window (no remote id): a re-submit could pay twice, so
    // it goes to a human. shot_1 has a remote id and simply resumes polling (R-P1-3).
    expect(final?.harnessShots?.map((shot) => shot.status)).toEqual(["needs_review", "succeeded"]);
    expect(final?.harnessShots?.[0]?.error).toMatchObject({ code: "uncertain_submit" });
    expect(submit).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalled();
  });
});
