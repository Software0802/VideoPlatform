import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeDurationSec, runFfmpeg } from "@/lib/ffmpeg";
import { stitchClips, StitchCanceled } from "./stitch";

async function makeClip(file: string, color: string, durationSec: number, audio: boolean) {
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x180:r=24:d=${durationSec}`,
  ];
  if (audio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${durationSec}`);
  }
  args.push("-t", String(durationSec), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast");
  if (audio) args.push("-c:a", "aac", "-shortest");
  else args.push("-an");
  args.push(file);
  await runFfmpeg(args);
}

describe("harness stitch", () => {
  it("rejects empty lists, xfade, and invalid settle duration", async () => {
    await expect(stitchClips({ clips: [], outputPath: "out.mp4" })).rejects.toThrow("拼接列表不能为空");
    await expect(
      stitchClips({ clips: ["a.mp4"], outputPath: "out.mp4", transition: "xfade" }),
    ).rejects.toThrow("目前仅支持硬切拼接");
    await expect(
      stitchClips({
        clips: ["a.mp4"],
        outputPath: "out.mp4",
        settleLastFrame: true,
        settleSec: 0.2,
      }),
    ).rejects.toThrow("尾帧定格须为 0.5–1.0 秒");
  });

  it("hard-cuts silent clips, loudnorms audio, and optionally freeze-settles the tail", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lumen-stitch-test-"));
    try {
      const first = path.join(dir, "a.mp4");
      const second = path.join(dir, "b.mp4");
      const output = path.join(dir, "out.mp4");
      await makeClip(first, "red", 1, false);
      await makeClip(second, "blue", 1, true);

      const result = await stitchClips({
        clips: [first, second],
        outputPath: output,
        workDir: path.join(dir, "work"),
        width: 320,
        height: 180,
        fps: 24,
        settleLastFrame: true,
        settleSec: 0.5,
      });

      expect(result.clipCount).toBe(2);
      expect(result.width).toBe(320);
      expect(result.height).toBe(180);
      expect(result.durationSec).toBeGreaterThan(2.2);
      expect(result.durationSec).toBeLessThan(2.9);
      const probe = await probeDurationSec(output);
      expect(probe.hasAudio).toBe(true);
      expect(probe.durationSec).toBeCloseTo(result.durationSec, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not write the destination when cancellation wins before commit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lumen-stitch-cancel-"));
    try {
      const clip = path.join(dir, "a.mp4");
      const output = path.join(dir, "out.mp4");
      await makeClip(clip, "green", 1, false);
      await expect(
        stitchClips({
          clips: [clip],
          outputPath: output,
          width: 320,
          height: 180,
          fps: 24,
          isCanceled: async () => true,
        }),
      ).rejects.toBeInstanceOf(StitchCanceled);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
