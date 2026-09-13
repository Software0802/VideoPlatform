import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoProvider } from "@/lib/providers/types";
import type { JobRecord } from "@/lib/jobs/schema";
import type { HarnessPlan } from "./types";

let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;
let saveHarnessPlan: (jobId: string, plan: HarnessPlan) => Promise<JobRecord>;
let runPersistedShot: (jobId: string, shotId: string, options: {
  provider?: VideoProvider;
  resolveAsset: (assetId: string) => { kind: "data_uri"; dataUri: string };
  persistOutput: (shot: unknown, handle: unknown) => Promise<string>;
  pollIntervalMs?: number;
}) => Promise<JobRecord>;

const plan: HarnessPlan = {
  targetDurationSec: 30,
  packing: { clips: [
    { kind: "generate", durationSec: 10 },
    { kind: "generate", durationSec: 10 },
    { kind: "generate", durationSec: 10 },
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
      durationSec: 10,
      prompt: "第一镜",
      characterIds: [],
      route: "t2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
    {
      id: "shot_1",
      index: 1,
      durationSec: 10,
      prompt: "第二镜",
      characterIds: [],
      route: "t2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
    {
      id: "shot_2",
      index: 2,
      durationSec: 10,
      prompt: "第三镜",
      characterIds: [],
      route: "t2v",
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
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-persisted-shot-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob } = await import("@/lib/jobs/store"));
  ({ saveHarnessPlan } = await import("./state"));
  ({ runPersistedShot } = await import("./run-persisted-shot"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("persisted shot runner", () => {
  it("persists success and skips the same succeeded shot after restart", async () => {
    const id = "job_persisted_shot";
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    const submit = vi.fn(async () => ({
      providerId: "mock" as const,
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
    const persistOutput = vi.fn(async () => {
      const output = path.join(dataRoot, "jobs", id, "shots", "0", "video.mp4");
      await mkdir(path.dirname(output), { recursive: true });
      await import("node:fs/promises").then(({ writeFile }) => writeFile(output, Buffer.from("clip")));
      return "shots/0/video.mp4";
    });
    const options = {
      provider,
      resolveAsset: (assetId: string) => ({ kind: "data_uri" as const, dataUri: assetId }),
      persistOutput,
      pollIntervalMs: 0,
    };

    await runPersistedShot(id, "shot_0", options);
    const first = await readJob(id);
    expect(first?.harnessShots?.[0]).toMatchObject({
      status: "succeeded",
      outputPath: "shots/0/video.mp4",
    });

    await runPersistedShot(id, "shot_0", options);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(persistOutput).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(dataRoot, "jobs", id, "shots", "0", "video.mp4"))).resolves.toEqual(
      Buffer.from("clip"),
    );
  });
});
