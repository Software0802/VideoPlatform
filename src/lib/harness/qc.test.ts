import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFfmpeg } from "@/lib/ffmpeg";
import {
  assertShotQc,
  evaluateShotQc,
  parseBlackdetect,
  parseFreezedetect,
  runShotQc,
  ShotQcFailure,
} from "./qc";

const BLACK_LOG = `[blackdetect @ 0000] black_start:0 black_end:0.75 black_duration:0.75
frame=  120 fps=0.0 q=-0.0 size=N/A time=00:00:05.00
[blackdetect @ 0000] black_start:3.5 black_end:3.6 black_duration:0.1`;

const FREEZE_LOG = `[freezedetect @ 0000] lavfi.freezedetect.freeze_start: 1
[freezedetect @ 0000] lavfi.freezedetect.freeze_duration: 2.5
[freezedetect @ 0000] lavfi.freezedetect.freeze_end: 3.5`;

async function lavfiClip(file: string, source: string, durationSec: number) {
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${source}${source.includes("=") ? ":" : "="}s=64x36:r=12:d=${durationSec}`,
    "-t",
    String(durationSec),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
}

describe("harness qc parsing", () => {
  it("parses blackdetect and freezedetect stderr", () => {
    expect(parseBlackdetect(BLACK_LOG)).toEqual([
      { start: 0, end: 0.75, duration: 0.75 },
      { start: 3.5, end: 3.6, duration: 0.1 },
    ]);
    expect(parseFreezedetect(FREEZE_LOG)).toEqual([{ start: 1, end: 3.5, duration: 2.5 }]);
  });

  it("applies duration tolerance and segment minimums", () => {
    const ok = evaluateShotQc(
      { durationSec: 15.3, blackSegments: [{ start: 0, end: 0.2, duration: 0.2 }], freezeSegments: [] },
      { expectedDurationSec: 15 },
    );
    expect(ok).toMatchObject({ durationOk: true, blackFrameFree: true, freezeFree: true });
    expect(() => assertShotQc(ok, 15)).not.toThrow();

    const bad = evaluateShotQc(
      {
        durationSec: 14.5,
        blackSegments: parseBlackdetect(BLACK_LOG),
        freezeSegments: parseFreezedetect(FREEZE_LOG),
      },
      { expectedDurationSec: 15 },
    );
    expect(bad).toMatchObject({ durationOk: false, blackFrameFree: false, freezeFree: false });
    expect(bad.blackSegments).toHaveLength(1);
    let error: unknown;
    try {
      assertShotQc(bad, 15);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ShotQcFailure);
    expect((error as ShotQcFailure).code).toBe("qc_duration");
  });
});

describe("harness qc on real clips", () => {
  it("passes a moving test pattern and rejects a black clip", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lumen-qc-test-"));
    try {
      const moving = path.join(dir, "moving.mp4");
      const black = path.join(dir, "black.mp4");
      await lavfiClip(moving, "testsrc2", 2);
      await lavfiClip(black, "color=c=black", 2);

      const report = await runShotQc(moving, { expectedDurationSec: 2 });
      expect(report).toMatchObject({ durationOk: true, blackFrameFree: true, freezeFree: true });

      await expect(runShotQc(black, { expectedDurationSec: 2 })).rejects.toMatchObject({
        code: "qc_black_frames",
      });
      await expect(runShotQc(moving, { expectedDurationSec: 5 })).rejects.toMatchObject({
        code: "qc_duration",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
