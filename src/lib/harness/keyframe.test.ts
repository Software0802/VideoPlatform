import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { runFfmpeg } from "@/lib/ffmpeg";
import {
  chooseSharpestFrame,
  extractSharpestTailFrame,
  laplacianVariance,
} from "./keyframe";

async function imageBuffer(pattern: "flat" | "checker") {
  const width = 32;
  const height = 32;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pattern === "flat" ? 128 : (x + y) % 2 === 0 ? 0 : 255;
      const offset = (y * width + x) * 3;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe("keyframe sharpness", () => {
  it("scores a high-frequency frame above a flat frame", async () => {
    const flat = await laplacianVariance(await imageBuffer("flat"));
    const checker = await laplacianVariance(await imageBuffer("checker"));
    expect(flat).toBe(0);
    expect(checker).toBeGreaterThan(flat);
  });

  it("selects the first highest-scoring candidate deterministically", () => {
    const first = { path: "a.jpg", score: 12 };
    const second = { path: "b.jpg", score: 12 };
    expect(chooseSharpestFrame([first, second])).toBe(first);
    expect(() => chooseSharpestFrame([])).toThrow("没有候选帧");
  });

  it("extracts a non-empty frame from the final tail window", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lumen-keyframe-test-"));
    const videoPath = path.join(dir, "fixture.mp4");
    const outputPath = path.join(dir, "link.jpg");
    try {
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=12",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        videoPath,
      ]);
      const result = await extractSharpestTailFrame(videoPath, outputPath, {
        durationSec: 1,
        windowSec: 0.5,
        sampleCount: 4,
      });
      expect(result.path).toBe(outputPath);
      expect(result.candidateCount).toBeGreaterThan(0);
      expect((await stat(outputPath)).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
