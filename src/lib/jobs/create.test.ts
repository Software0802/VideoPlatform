import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { JobPublic, JobRecord } from "./schema";

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let createJob: (
  body: {
    mode: "image_to_video";
    prompt: string;
    durationSec: number;
    startUploadId: string;
  },
  ownerId: string,
) => Promise<{ job: JobPublic; replay: boolean }>;
let readJob: (id: string) => Promise<{ status: string } | null>;
let retryJob: (source: JobRecord, ownerId: string) => Promise<JobPublic>;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-create-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createJob, retryJob } = await import("./create"));
  ({ readJob } = await import("./store"));
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
