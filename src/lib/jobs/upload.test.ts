import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { handleUpload } from "./upload";

let dataRoot = "";

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-upload-test-"));
  process.env.DATA_DIR = dataRoot;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("handleUpload", () => {
  it("rejects a multipart request that has no file", async () => {
    const form = new FormData();
    form.set("role", "start");
    await expect(
      handleUpload(
        new Request("http://localhost/api/uploads", { method: "POST", body: form }),
      ),
    ).rejects.toThrow("缺少文件");
  });

  it("rejects non-multipart requests with a client error", async () => {
    await expect(
      handleUpload(
        new Request("http://localhost/api/uploads", {
          method: "POST",
          body: JSON.stringify({ role: "start" }),
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("multipart/form-data");
  });

  it("removes the temporary video when ffmpeg probing fails", async () => {
    const form = new FormData();
    form.set("role", "source_video");
    form.set("file", new Blob(["not an mp4"], { type: "video/mp4" }), "broken.mp4");
    const request = new Request("http://localhost/api/uploads", {
      method: "POST",
      body: form,
    });

    await expect(handleUpload(request)).rejects.toThrow("仅支持 MP4 视频");
    const names = await readdir(path.join(dataRoot, "tmp")).catch(() => []);
    expect(names).toEqual([]);
  });

  it("reads the role even when the multipart field follows the file", async () => {
    const image = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg()
      .toBuffer();
    const form = new FormData();
    form.append(
      "file",
      new Blob([image], { type: "image/jpeg" }),
      "frame.jpg",
    );
    form.append("role", "last");

    const side = await handleUpload(
      new Request("http://localhost/api/uploads", { method: "POST", body: form }),
    );

    expect(side.role).toBe("last");
    await rm(path.join(dataRoot, "tmp", side.uploadId), { force: true });
    await rm(path.join(dataRoot, "tmp", `${side.uploadId}.json`), { force: true });
  });
});
