import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

export function ffmpegBinary(): string {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary missing");
  return ffmpegPath;
}

export async function assertFfmpeg(): Promise<string> {
  const bin = ffmpegBinary();
  await access(bin);
  return bin;
}

export function watermarkFontPath(): string {
  return path.join(process.cwd(), "src/lib/media/fonts/NotoSansSC-subset.ttf");
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const bin = await assertFfmpeg();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}

export async function probeDurationSec(file: string): Promise<{
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}> {
  const bin = await assertFfmpeg();
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ["-i", file], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => {
      err += String(c);
    });
    child.on("error", reject);
    child.on("close", () => resolve(err));
  });
  if (!isMp4Container(text)) throw new Error("仅支持 MP4 视频");
  return { ...parseFfmpegVideoInfo(text), hasAudio: /\bAudio:/.test(text) };
}

export function isMp4Container(text: string): boolean {
  const line = text.split(/\r?\n/).find((value) => value.includes("Input #0,"));
  if (!line) return false;
  const formatList = line.split(/Input #0,\s*/i)[1]?.split(/,\s*from\b/i)[0] ?? "";
  return /(?:^|,)\s*mp4\s*(?:,|$)/i.test(formatList);
}

export function parseFfmpegVideoInfo(text: string): {
  durationSec: number;
  width: number;
  height: number;
} {
  const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!dur) throw new Error("无法解析视频时长");
  const durationSec =
    Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  const videoLines = text.split(/\r?\n/).filter((line) => /\bVideo:/.test(line));
  const dimensions = videoLines
    .flatMap((line) => [...line.matchAll(/(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,])/g)])
    .at(-1);
  return {
    durationSec,
    width: dimensions ? Number(dimensions[1]) : 0,
    height: dimensions ? Number(dimensions[2]) : 0,
  };
}
