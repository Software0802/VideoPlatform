import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeDurationSec, runFfmpeg } from "@/lib/ffmpeg";
import { commitLocalOutput } from "@/lib/jobs/local-output";

export type StitchOptions = {
  clips: readonly string[];
  outputPath: string;
  workDir?: string;
  transition?: "hard_cut" | "xfade";
  settleLastFrame?: boolean;
  settleSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  isCanceled?: () => Promise<boolean>;
};

export type StitchResult = {
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  clipCount: number;
};

const AUDIO_FADE_SEC = 0.02;
const DEFAULT_SETTLE_SEC = 0.75;
const DEFAULT_FPS = 24;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export class StitchCanceled extends Error {
  constructor() {
    super("拼接已取消");
    this.name = "StitchCanceled";
  }
}

export async function stitchClips(options: StitchOptions): Promise<StitchResult> {
  if (!options.clips.length) throw new Error("拼接列表不能为空");
  const transition = options.transition ?? "hard_cut";
  if (transition !== "hard_cut") throw new Error("目前仅支持硬切拼接");

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const fps = options.fps ?? DEFAULT_FPS;
  if (!Number.isInteger(width) || width < 16 || !Number.isInteger(height) || height < 16) {
    throw new Error("拼接分辨率无效");
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error("拼接帧率无效");
  }
  const settleSec = options.settleLastFrame ? clampSettle(options.settleSec ?? DEFAULT_SETTLE_SEC) : 0;
  const isCanceled = options.isCanceled ?? (async () => false);
  if (await isCanceled()) throw new StitchCanceled();

  const createdWorkDir = !options.workDir;
  const workDir = options.workDir ?? (await mkdtemp(path.join(os.tmpdir(), "lumen-stitch-")));
  await mkdir(workDir, { recursive: true });

  try {
    const normalized: string[] = [];
    for (const [index, clip] of options.clips.entries()) {
      if (await isCanceled()) throw new StitchCanceled();
      const dest = path.join(workDir, `norm-${String(index).padStart(2, "0")}.mp4`);
      await normalizeClip(clip, dest, {
        width,
        height,
        fps,
        fadeIn: index > 0,
        fadeOut: index < options.clips.length - 1 || settleSec > 0,
      });
      normalized.push(dest);
    }

    if (settleSec > 0) {
      if (await isCanceled()) throw new StitchCanceled();
      const settlePath = path.join(workDir, "settle.mp4");
      await makeSettleClip(normalized[normalized.length - 1]!, settlePath, {
        width,
        height,
        fps,
        durationSec: settleSec,
      });
      normalized.push(settlePath);
    }

    const concatList = path.join(workDir, "concat.txt");
    await writeFile(concatList, `${normalized.map(concatEntry).join("\n")}\n`);
    const concatenated = path.join(workDir, "concat.mp4");
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "44100",
      concatenated,
    ]);

    if (await isCanceled()) throw new StitchCanceled();
    const staged = path.join(workDir, "loudnorm.mp4");
    await runFfmpeg([
      "-y",
      "-i",
      concatenated,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar",
      "44100",
      staged,
    ]);

    if (await isCanceled()) throw new StitchCanceled();
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    const committed = await commitLocalOutput(staged, options.outputPath, isCanceled);
    if (!committed) throw new StitchCanceled();

    const probe = await probeDurationSec(options.outputPath);
    return {
      outputPath: options.outputPath,
      durationSec: probe.durationSec,
      width: probe.width || width,
      height: probe.height || height,
      clipCount: options.clips.length,
    };
  } finally {
    if (createdWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function clampSettle(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0.5 || sec > 1) {
    throw new Error("尾帧定格须为 0.5–1.0 秒");
  }
  return sec;
}

function concatEntry(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/").replaceAll("'", "'\\''");
  return `file '${normalized}'`;
}

function audioFadeFilters(durationSec: number, fadeIn: boolean, fadeOut: boolean): string[] {
  const filters: string[] = [];
  if (fadeIn) filters.push(`afade=t=in:st=0:d=${AUDIO_FADE_SEC}`);
  if (fadeOut) {
    const start = Math.max(0, durationSec - AUDIO_FADE_SEC);
    filters.push(`afade=t=out:st=${start.toFixed(3)}:d=${AUDIO_FADE_SEC}`);
  }
  return filters;
}

async function normalizeClip(
  input: string,
  output: string,
  spec: { width: number; height: number; fps: number; fadeIn: boolean; fadeOut: boolean },
) {
  const probed = await probeDurationSec(input);
  if (!Number.isFinite(probed.durationSec) || probed.durationSec <= 0) {
    throw new Error("拼接源片时长无效");
  }
  const vf = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease`,
    `pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${spec.fps}`,
    "format=yuv420p",
  ].join(",");
  const fades = audioFadeFilters(probed.durationSec, spec.fadeIn, spec.fadeOut);
  const audioChain = ["aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100", ...fades].join(",");

  if (probed.hasAudio) {
    await runFfmpeg([
      "-y",
      "-i",
      input,
      "-filter_complex",
      `[0:v]${vf}[v];[0:a]${audioChain}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-shortest",
      output,
    ]);
    return;
  }

  await runFfmpeg([
    "-y",
    "-i",
    input,
    "-f",
    "lavfi",
    "-t",
    probed.durationSec.toFixed(3),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex",
    `[0:v]${vf}[v];[1:a]${audioChain}[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-shortest",
    output,
  ]);
}

async function makeSettleClip(
  lastClip: string,
  output: string,
  spec: { width: number; height: number; fps: number; durationSec: number },
) {
  const framePath = path.join(path.dirname(output), "settle.jpg");
  const probed = await probeDurationSec(lastClip);
  const seek = Math.max(0, probed.durationSec - 1 / spec.fps);
  await runFfmpeg([
    "-y",
    "-ss",
    seek.toFixed(3),
    "-i",
    lastClip,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-update",
    "1",
    framePath,
  ]);
  try {
    await access(framePath);
  } catch {
    await runFfmpeg(["-y", "-i", lastClip, "-q:v", "2", "-f", "image2", "-update", "1", framePath]);
    await access(framePath);
  }
  const fades = audioFadeFilters(spec.durationSec, true, false);
  const audioChain = ["aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=44100", ...fades].join(",");
  await runFfmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    framePath,
    "-f",
    "lavfi",
    "-t",
    spec.durationSec.toFixed(3),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t",
    spec.durationSec.toFixed(3),
    "-filter_complex",
    `[0:v]scale=${spec.width}:${spec.height},fps=${spec.fps},format=yuv420p[v];[1:a]${audioChain}[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-shortest",
    output,
  ]);
}
