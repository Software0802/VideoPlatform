import { copyFile, mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { probeDurationSec, runFfmpeg } from "@/lib/ffmpeg";

export type TailFrameCandidate = Readonly<{
  path: string;
  score: number;
}>;

export type TailFrameResult = {
  path: string;
  score: number;
  candidateCount: number;
};

export type TailFrameOptions = {
  durationSec?: number;
  windowSec?: number;
  sampleCount?: number;
};

const DEFAULT_WINDOW_SEC = 0.5;
const DEFAULT_SAMPLE_COUNT = 12;

/** Score an image with the variance of its grayscale Laplacian. */
export async function laplacianVariance(input: Buffer): Promise<number> {
  const { data, info } = await sharp(input)
    .greyscale()
    .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width < 3 || info.height < 3) return 0;

  const channels = info.channels;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const center = data[(y * info.width + x) * channels] ?? 0;
      const left = data[(y * info.width + x - 1) * channels] ?? 0;
      const right = data[(y * info.width + x + 1) * channels] ?? 0;
      const up = data[((y - 1) * info.width + x) * channels] ?? 0;
      const down = data[((y + 1) * info.width + x) * channels] ?? 0;
      const laplacian = 4 * center - left - right - up - down;
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

export function chooseSharpestFrame(
  candidates: readonly TailFrameCandidate[],
): TailFrameCandidate {
  if (!candidates.length) throw new Error("没有候选帧");
  return candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
}

/**
 * Extract frames from the last 0.5s of an MP4 and copy the sharpest one to outputPath.
 * The candidate directory is disposable and is always removed before returning.
 */
export async function extractSharpestTailFrame(
  videoPath: string,
  outputPath: string,
  options: TailFrameOptions = {},
): Promise<TailFrameResult> {
  const windowSec = options.windowSec ?? DEFAULT_WINDOW_SEC;
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  if (
    !Number.isFinite(windowSec) ||
    windowSec <= 0 ||
    windowSec > 5 ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 1 ||
    sampleCount > 24
  ) {
    throw new Error("尾帧参数无效");
  }

  const durationSec = options.durationSec ?? (await probeDurationSec(videoPath)).durationSec;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("视频时长无效");
  }
  const effectiveWindow = Math.min(windowSec, durationSec);
  const startSec = Math.max(0, durationSec - effectiveWindow);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lumen-tail-frame-"));
  try {
    const pattern = path.join(tempDir, "frame-%02d.jpg");
    await runFfmpeg([
      "-y",
      "-ss",
      startSec.toFixed(3),
      "-i",
      videoPath,
      "-t",
      effectiveWindow.toFixed(3),
      "-vf",
      `fps=${(sampleCount / effectiveWindow).toFixed(6)}`,
      "-frames:v",
      String(sampleCount),
      "-q:v",
      "2",
      pattern,
    ]);

    const names = (await readdir(tempDir))
      .filter((name) => /^frame-\d+\.jpg$/i.test(name))
      .sort();
    const candidates = await Promise.all(
      names.map(async (name) => {
        const candidatePath = path.join(tempDir, name);
        return {
          path: candidatePath,
          score: await laplacianVariance(await readFile(candidatePath)),
        };
      }),
    );
    const best = chooseSharpestFrame(candidates);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(best.path, outputPath);
    return { path: outputPath, score: best.score, candidateCount: candidates.length };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
