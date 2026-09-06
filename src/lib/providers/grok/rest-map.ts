import { ticksToUsd } from "@/lib/cost";
import { clampProgress } from "@/lib/jobs/schema";
import { endpointForMode, isImageMode, MODEL_1_5 } from "@/lib/providers/grok/mode-matrix";
import type {
  MediaRef,
  NativeMode,
  ProviderGenerateRequest,
  ProviderPoll,
} from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

export type GrokRestCall = {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
};

function mediaToGrok(ref: MediaRef): { url?: string; file_id?: string } {
  if (ref.kind === "file_id") return { file_id: ref.fileId };
  if (ref.kind === "data_uri") return { url: ref.dataUri };
  if (ref.kind === "url") return { url: ref.url };
  throw new ProviderHttpError(400, "invalid_argument", "path 媒体必须先转成 data URI 或 file_id");
}

function sourceVideoToGrok(ref: MediaRef): { file_id: string } {
  if (ref.kind !== "file_id") {
    throw new ProviderHttpError(400, "invalid_argument", "源视频必须使用 file_id，禁止 data URI");
  }
  return { file_id: ref.fileId };
}

export function mapToGrokRest(req: ProviderGenerateRequest): GrokRestCall {
  const mode = req.mode;
  assertModeConstraints(req);

  const path = endpointForMode(mode);
  const body: Record<string, unknown> = { model: req.model };
  const ext = isImageMode(mode) ? "jpg" : "mp4";
  body.storage_options = { filename: `${req.jobId}.${ext}` };

  if (mode === "text_to_image") {
    body.prompt = req.prompt;
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    if (req.imageResolution) body.resolution = req.imageResolution;
  } else if (mode === "text_to_video") {
    body.prompt = req.prompt;
    putGenFields(body, req);
  } else if (mode === "image_to_video") {
    if (!req.startImage) {
      throw new ProviderHttpError(400, "invalid_argument", "图生视频需要首页图");
    }
    body.image = mediaToGrok(req.startImage);
    if (req.prompt.trim()) body.prompt = req.prompt;
    putGenFields(body, req);
  } else if (mode === "reference_to_video") {
    body.prompt = req.prompt;
    if (req.referenceImages?.length) {
      body.reference_images = req.referenceImages.map(mediaToGrok);
    }
    if (req.referenceAudios?.length) {
      body.reference_audios = req.referenceAudios.map((a) => ({ voice_id: a.voiceId }));
    }
    putGenFields(body, req);
  } else if (mode === "edit_video") {
    if (!req.sourceVideo) {
      throw new ProviderHttpError(400, "invalid_argument", "视频编辑需要源视频");
    }
    body.prompt = req.prompt;
    body.video = sourceVideoToGrok(req.sourceVideo);
  } else if (mode === "extend_video") {
    if (!req.sourceVideo) {
      throw new ProviderHttpError(400, "invalid_argument", "视频延长需要源视频");
    }
    body.prompt = req.prompt;
    body.video = sourceVideoToGrok(req.sourceVideo);
    body.duration = req.durationSec ?? 6;
  }

  return { method: "POST", path, body };
}

function putGenFields(body: Record<string, unknown>, req: ProviderGenerateRequest) {
  if (req.durationSec != null) body.duration = req.durationSec;
  if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
  if (req.resolution) body.resolution = req.resolution;
  if (req.generateAudio === false) body.generate_audio = false;
}

export function assertModeConstraints(req: ProviderGenerateRequest) {
  const { mode } = req;
  if (req.startImage && req.referenceImages?.length) {
    throw new ProviderHttpError(400, "invalid_argument", "首页图与参考图不能同时使用");
  }
  // 尾帧永不进入 Grok 请求体（`capabilities().supportsLastFrameLock === false`）。
  // 走到这里说明上游选择出了错，宁可 400 也不出一段没锁尾帧、却按锁了收钱的片子。
  if (req.lastImage) {
    throw new ProviderHttpError(400, "invalid_argument", "当前模型不支持首尾帧");
  }
  if (HARNESS_DURATION(req.durationSec)) {
    throw new ProviderHttpError(
      400,
      "harness_duration",
      "长视频将由一致性管线提供，尚未开放",
    );
  }
  if (mode === "text_to_image" && !req.prompt.trim()) {
    throw new ProviderHttpError(400, "invalid_argument", "文生图需要提示词");
  }
  if (mode === "text_to_image" && req.generateAudio) {
    throw new ProviderHttpError(400, "invalid_argument", "文生图不支持音频");
  }
  if (mode === "text_to_video" && !req.prompt.trim()) {
    throw new ProviderHttpError(400, "invalid_argument", "文生视频需要提示词");
  }
  if (
    (mode === "reference_to_video" || mode === "edit_video" || mode === "extend_video") &&
    !req.prompt.trim()
  ) {
    throw new ProviderHttpError(400, "invalid_argument", "该模式需要提示词");
  }
  if (
    (mode === "text_to_video" || mode === "image_to_video" || mode === "reference_to_video") &&
    req.durationSec != null &&
    (!Number.isInteger(req.durationSec) || req.durationSec < 1 || req.durationSec > 15)
  ) {
    throw new ProviderHttpError(400, "invalid_argument", "视频时长须为 1–15 秒的整数");
  }
  if (mode === "text_to_image" && req.durationSec != null) {
    throw new ProviderHttpError(400, "invalid_argument", "文生图不能指定视频时长");
  }
  if (mode !== "image_to_video" && req.startImage) {
    throw new ProviderHttpError(400, "invalid_argument", "首帧图只适用于图生视频");
  }
  if (mode !== "reference_to_video" && (req.referenceImages?.length || req.referenceAudios?.length)) {
    throw new ProviderHttpError(400, "invalid_argument", "参考图和参考音色只适用于参考生视频");
  }
  if (mode !== "text_to_image" && req.imageResolution) {
    throw new ProviderHttpError(400, "invalid_argument", "图片分辨率只适用于文生图");
  }
  if (isImageMode(mode) && req.sourceVideo) {
    throw new ProviderHttpError(400, "invalid_argument", "文生图不接受源视频");
  }
  if (isImageMode(mode) && req.resolution) {
    throw new ProviderHttpError(400, "invalid_argument", "文生图分辨率须为 1k 或 2k");
  }
  if (mode === "image_to_video" && !req.startImage) {
    throw new ProviderHttpError(400, "invalid_argument", "图生视频需要首页图");
  }
  if (mode === "reference_to_video") {
    const nImg = req.referenceImages?.length ?? 0;
    const nVoice = req.referenceAudios?.length ?? 0;
    if (nImg === 0 && nVoice === 0) {
      throw new ProviderHttpError(400, "invalid_argument", "参考生视频至少需要一张参考图或一个音色");
    }
    if (nImg > 7) throw new ProviderHttpError(400, "invalid_argument", "参考图最多 7 张");
    if (nVoice > 3) throw new ProviderHttpError(400, "invalid_argument", "音色最多 3 个");
    if (req.resolution === "1080p") {
      throw new ProviderHttpError(400, "invalid_argument", "参考生视频最高 720p");
    }
  }
  if ((mode === "edit_video" || mode === "extend_video") && !req.sourceVideo) {
    throw new ProviderHttpError(400, "invalid_argument", "该模式需要源视频");
  }
  if (req.sourceVideo && req.sourceVideo.kind !== "file_id") {
    throw new ProviderHttpError(400, "invalid_argument", "源视频必须使用 file_id，禁止 data URI");
  }
  if (mode === "extend_video") {
    const d = req.durationSec ?? 6;
    if (!Number.isInteger(d) || d < 2 || d > 10) {
      throw new ProviderHttpError(400, "invalid_argument", "延长段须为 2–10 秒");
    }
    if (req.aspectRatio || req.resolution) {
      throw new ProviderHttpError(400, "invalid_argument", "延长不能指定画幅或分辨率");
    }
  }
  if (mode === "edit_video") {
    if (req.durationSec != null || req.aspectRatio || req.resolution) {
      throw new ProviderHttpError(400, "invalid_argument", "编辑不能指定时长、画幅或分辨率");
    }
  }
  const genModes: NativeMode[] = ["text_to_video", "image_to_video", "reference_to_video"];
  if (genModes.includes(mode) && req.sourceVideo) {
    throw new ProviderHttpError(400, "invalid_argument", "该模型不接受源视频");
  }
  if (req.model === MODEL_1_5 && req.sourceVideo) {
    throw new ProviderHttpError(400, "invalid_argument", "grok-imagine-video-1.5 不接受源视频");
  }
}

function HARNESS_DURATION(d?: number) {
  return d === 30 || d === 45 || d === 60;
}

export function mapPoll(data: Record<string, unknown>): ProviderPoll {
  const status = String(data.status ?? "pending") as ProviderPoll["status"];
  const video = (data.video ?? {}) as Record<string, unknown>;
  const error = (data.error ?? {}) as Record<string, unknown>;
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const fileOutput = (video.file_output ?? {}) as Record<string, unknown>;
  const ticks =
    typeof usage.cost_in_usd_ticks === "number" ? usage.cost_in_usd_ticks : undefined;
  const progress = clampProgress(
    typeof data.progress === "number"
      ? data.progress
      : status === "done"
        ? 100
        : 0,
  );

  return {
    status: ["pending", "done", "failed", "expired"].includes(status)
      ? status
      : "pending",
    progress,
    remoteUrl: typeof video.url === "string" ? video.url : undefined,
    durationSec: typeof video.duration === "number" ? video.duration : undefined,
    respectModeration:
      typeof video.respect_moderation === "boolean" ? video.respect_moderation : undefined,
    errorCode: typeof error.code === "string" ? error.code : undefined,
    errorMessage: typeof error.message === "string" ? error.message : undefined,
    usage:
      ticks != null
        ? { costInUsdTicks: ticks, costUsdActual: ticksToUsd(ticks), raw: usage }
        : undefined,
    fileOutputId: typeof fileOutput.file_id === "string" ? fileOutput.file_id : undefined,
  };
}
