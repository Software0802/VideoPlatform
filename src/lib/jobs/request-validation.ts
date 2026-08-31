import { ProviderHttpError } from "@/lib/providers/types";
import type { CreateJobBody } from "@/lib/jobs/schema";

const GENERATED_VIDEO_MODES: ReadonlySet<CreateJobBody["mode"]> = new Set([
  "text_to_video",
  "image_to_video",
  "reference_to_video",
] as const);

const VIDEO_MODES: ReadonlySet<CreateJobBody["mode"]> = new Set([
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit_video",
  "extend_video",
] as const);

function reject(message: string): never {
  throw new ProviderHttpError(400, "invalid_argument", message);
}

function has(body: CreateJobBody, key: keyof CreateJobBody): boolean {
  return body[key] !== undefined;
}

/**
 * Validate fields that are specific to the HTTP create-job contract.
 * Asset role and source duration checks happen after sidecars are loaded.
 */
export function assertCreateJobFields(body: CreateJobBody): void {
  const { mode } = body;
  for (const [label, values] of [
    ["参考图", body.referenceUploadIds],
    ["参考音色", body.voiceIds],
  ] as const) {
    if (values && new Set(values).size !== values.length) {
      reject(`${label}不能重复选择`);
    }
  }
  const promptRequired =
    mode === "text_to_image" ||
    mode === "text_to_video" ||
    mode === "reference_to_video" ||
    mode === "edit_video" ||
    mode === "extend_video";

  if (promptRequired && !body.prompt.trim()) {
    reject("该模式需要提示词");
  }

  if (GENERATED_VIDEO_MODES.has(mode)) {
    if (
      body.durationSec !== undefined &&
      (!Number.isInteger(body.durationSec) || body.durationSec < 1 || body.durationSec > 15)
    ) {
      reject("视频时长须为 1–15 秒的整数");
    }
  } else if (mode === "extend_video") {
    if (
      body.durationSec !== undefined &&
      (!Number.isInteger(body.durationSec) || body.durationSec < 2 || body.durationSec > 10)
    ) {
      reject("延长段须为 2–10 秒的整数");
    }
  } else if (has(body, "durationSec")) {
    reject(mode === "text_to_image" ? "文生图不能指定视频时长" : "编辑不能指定时长");
  }

  if (mode === "edit_video" || mode === "extend_video") {
    if (has(body, "aspectRatio") || has(body, "resolution")) {
      reject(mode === "edit_video" ? "编辑不能指定画幅或分辨率" : "延长不能指定画幅或分辨率");
    }
    if (has(body, "generateAudio")) {
      reject("该模式不能指定生成音频");
    }
  }

  if (mode === "text_to_image") {
    if (has(body, "resolution")) reject("文生图分辨率须使用 1k 或 2k");
    if (body.generateAudio === true) reject("文生图不支持音频");
    if (has(body, "imageResolution") && !["1k", "2k"].includes(body.imageResolution!)) {
      reject("文生图分辨率须为 1k 或 2k");
    }
  } else if (has(body, "imageResolution")) {
    reject("视频模式不能指定图片分辨率");
  }

  if (mode === "reference_to_video" && body.resolution === "1080p") {
    reject("参考生视频最高 720p");
  }

  if (mode === "image_to_video") {
    if (!body.startUploadId) reject("图生视频需要首帧图");
    if (has(body, "referenceUploadIds") || has(body, "voiceIds")) {
      reject("图生视频不能同时使用参考图或参考音色");
    }
  } else if (has(body, "startUploadId")) {
    reject("首帧图只适用于图生视频");
  }

  if (mode === "reference_to_video") {
    const references = body.referenceUploadIds?.length ?? 0;
    const voices = body.voiceIds?.length ?? 0;
    if (references === 0 && voices === 0) {
      reject("参考生视频至少需要一张参考图或一个音色");
    }
  } else if (has(body, "referenceUploadIds") || has(body, "voiceIds")) {
    reject("参考图和参考音色只适用于参考生视频");
  }

  if (mode === "edit_video" || mode === "extend_video") {
    if (!body.sourceVideoUploadId) reject("该模式需要源视频");
  } else if (has(body, "sourceVideoUploadId")) {
    reject("源视频只适用于编辑或延长模式");
  }

  if (mode === "text_to_image") {
    if (has(body, "lastUploadId")) reject("文生图不支持尾帧图");
  } else if (!VIDEO_MODES.has(mode) && has(body, "lastUploadId")) {
    reject("尾帧图只适用于视频模式");
  }
}
