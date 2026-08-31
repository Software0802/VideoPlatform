import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { JobPublic } from "./schema";

let dataRoot = "";
let createJob: (body: {
  mode: "image_to_video";
  prompt: string;
  durationSec: number;
  startUploadId: string;
}) => Promise<{ job: JobPublic; replay: boolean }>;
let readJob: (id: string) => Promise<{ status: string } | null>;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-create-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createJob } = await import("./create"));
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
        role: "start",
        width: 2,
        height: 2,
        bytes: jpeg.length,
        mimeType: "image/jpeg",
        durationSec: null,
        createdAt: new Date().toISOString(),
      }),
    );

    const { job } = await createJob({
      mode: "image_to_video",
      prompt: "a slow camera move",
      durationSec: 1,
      startUploadId: uploadId,
    });

    await expect(access(path.join(tmp, `${uploadId}.json`))).rejects.toThrow();
    await expect(readFile(path.join(dataRoot, "jobs", job.id, "inputs", "start.jpg"))).resolves.toEqual(jpeg);

    for (let i = 0; i < 12; i += 1) {
      const current = await readJob(job.id);
      if (current?.status === "succeeded" || current?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
});
