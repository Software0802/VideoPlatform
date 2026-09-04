import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { probeDurationSec, runFfmpeg, watermarkFontPath } from "@/lib/ffmpeg";
import { hashHue } from "@/lib/media/preprocess";
import { extractPoster } from "@/lib/media/poster";
import { mediaStore } from "@/lib/storage/local-fs";
import {
  ProviderHttpError,
  type ProviderGenerateRequest,
  type ProviderHandle,
  type ProviderPoll,
  type VideoProvider,
} from "@/lib/providers/types";

const pending = new Map<string, { doneAt: number; duration: number }>();

/** 开发用：提示词含此标记时 submit 直接抛上游错误，用来验证失败态 / 重试链路。 */
export const MOCK_FAIL_MARKER = "[fail]";

export const mockProvider: VideoProvider = {
  id: "mock",
  capabilities() {
    return {
      modes: [
        "text_to_image",
        "text_to_video",
        "image_to_video",
        "reference_to_video",
        "edit_video",
        "extend_video",
      ],
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    };
  },
  async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
    const sourceInfo = await sourceVideoInfo(req);
    const dimensions = sourceInfo
      ? fitDimensions(sourceInfo.width, sourceInfo.height)
      : stillSize(req.aspectRatio);
    const still = await makeStill(req, dimensions);
    if (req.prompt.includes(MOCK_FAIL_MARKER)) {
      throw new ProviderHttpError(502, "mock_failure", "模拟失败（提示词含 [fail]）");
    }
    if (req.mode === "text_to_image") {
      const outRel = "tmp/image.jpg";
      await mediaStore.writeJobFile(req.jobId, outRel, still);
      // Images are synchronous in the provider contract; the runner moves the
      // staged file straight to outputs and never polls this handle.
      return { providerId: "mock", remoteId: req.jobId, localVideoPath: outRel };
    }
    const duration =
      req.mode === "edit_video"
        ? (sourceInfo?.durationSec ?? 5)
        : req.mode === "extend_video"
          ? (sourceInfo ? sourceInfo.durationSec : 0) + (req.durationSec ?? 6)
          : (req.durationSec ?? 8);
    const stillPath = await mediaStore.writeJobFile(req.jobId, "tmp/still.jpg", still);
    const outRel = "tmp/video.mp4";
    const outAbs = path.join(mediaStore.jobDir(req.jobId), outRel);
    await kenBurns(stillPath, outAbs, duration, req.generateAudio, dimensions.w, dimensions.h);
    pending.set(req.jobId, {
      doneAt: Date.now() + 3500,
      duration,
    });
    return { providerId: "mock", remoteId: req.jobId, localVideoPath: outRel };
  },
  async poll(handle: ProviderHandle): Promise<ProviderPoll> {
    const rec = pending.get(handle.remoteId ?? "");
    if (!rec) {
      return { status: "done", progress: 100, respectModeration: true, durationSec: 8 };
    }
    const left = rec.doneAt - Date.now();
    if (left > 0) {
      return {
        status: "pending",
        progress: Math.min(99, Math.round((1 - left / 3500) * 100)),
      };
    }
    pending.delete(handle.remoteId ?? "");
    return {
      status: "done",
      progress: 100,
      durationSec: rec.duration,
      respectModeration: true,
    };
  },
};

function stillSize(aspect?: string): { w: number; h: number } {
  switch (aspect) {
    case "9:16":
      return { w: 720, h: 1280 };
    case "1:1":
      return { w: 1024, h: 1024 };
    case "4:3":
      return { w: 1280, h: 960 };
    case "3:4":
      return { w: 960, h: 1280 };
    case "3:2":
      return { w: 1280, h: 854 };
    case "2:3":
      return { w: 854, h: 1280 };
    default:
      return { w: 1280, h: 720 };
  }
}

/** Mock edit/extend follows the product's 720p (1280px long edge) cap. */
function fitDimensions(width: number, height: number): { w: number; h: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1280;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 720;
  const scale = Math.min(1, 1280 / Math.max(safeWidth, safeHeight));
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { w: even(safeWidth * scale), h: even(safeHeight * scale) };
}

async function makeStill(
  req: ProviderGenerateRequest,
  dimensions: { w: number; h: number },
): Promise<Buffer> {
  const { w, h } = dimensions;
  const hue = hashHue(req.prompt || req.jobId);
  const bg = `hsl(${hue} 18% 10%)`;
  const text = escapeXml((req.prompt || req.mode).slice(0, 40));
  const mark = "MOCK · 模拟模式 · 非 Grok 真片";
  if (req.startImage?.kind === "path") {
    const buf = await readFile(req.startImage.path);
    return overlay(buf, mark, w, h);
  }
  if (req.sourceVideo?.kind === "path") {
    const sourceStill = path.join(mediaStore.jobDir(req.jobId), "tmp/source-still.jpg");
    try {
      await extractPoster(req.sourceVideo.path, sourceStill);
      return overlay(await readFile(sourceStill), mark, w, h);
    } catch {
      // A valid upload should normally be seekable; use a generated still if
      // a damaged source cannot provide a poster in mock mode.
    } finally {
      await rm(sourceStill, { force: true }).catch(() => undefined);
    }
  }
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${bg}"/>
    <text x="50%" y="48%" fill="#e8dcc8" font-size="28" text-anchor="middle" font-family="sans-serif">${text}</text>
    <text x="50%" y="88%" fill="#c4a574" font-size="18" text-anchor="middle" font-family="sans-serif">${mark}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function overlay(buf: Buffer, mark: string, width: number, height: number): Promise<Buffer> {
  const svg = `<svg width="${width}" height="${height}">
    <text x="24" y="${height - 28}" fill="#c4a574" font-size="22" font-family="sans-serif">${mark}</text>
  </svg>`;
  return sharp(buf)
    .resize(width, height, { fit: "cover" })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

function escapeXml(s: string) {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

async function kenBurns(
  still: string,
  out: string,
  duration: number,
  audio: boolean,
  width: number,
  height: number,
) {
  // ffmpeg-static is built without libfreetype/drawtext. Watermark is burned into the still via sharp.
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `zoompan=z='min(zoom+0.0008,1.12)':d=1:s=${width}x${height}:fps=24`,
  ].join(",");

  const args = ["-y", "-loop", "1", "-i", still];
  if (audio) {
    args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=" + duration);
  }
  args.push(
    "-t",
    String(duration),
    "-r",
    "24",
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
  );
  if (audio) args.push("-c:a", "aac", "-shortest");
  else args.push("-an");
  args.push(out);
  await runFfmpeg(args);
}

async function sourceVideoInfo(req: ProviderGenerateRequest) {
  if (req.sourceVideo?.kind !== "path") return undefined;
  return probeDurationSec(req.sourceVideo.path);
}

export async function mockHasFont(): Promise<boolean> {
  try {
    await access(watermarkFontPath());
    return true;
  } catch {
    return false;
  }
}
