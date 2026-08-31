import {
  MODEL_1_0,
  MODEL_1_5,
} from "@/lib/providers/grok/mode-matrix";
import { ProviderHttpError, type MediaRef, type ProviderGenerateRequest } from "@/lib/providers/types";
import type { IdentityBible, Shot } from "./types";

export type ShotAssetResolver = (assetId: string) => MediaRef;

export type BuildShotRequestInput = {
  jobId: string;
  shot: Shot;
  bible: IdentityBible;
  resolveAsset: ShotAssetResolver;
  sourceVideo?: MediaRef;
  aspectRatio?: ProviderGenerateRequest["aspectRatio"];
  resolution?: ProviderGenerateRequest["resolution"];
};

export function buildShotRequest(input: BuildShotRequestInput): ProviderGenerateRequest {
  const { jobId, shot, bible, resolveAsset } = input;
  if (!jobId.trim()) throw invalid("shot jobId 无效");
  assertContinuity(shot);

  if (shot.route === "jimeng_first_last") {
    throw invalid("Jimeng 尚未启用");
  }

  const base = {
    jobId: `${jobId}-shot-${shot.index}`,
    prompt: shot.prompt,
    generateAudio: shot.generateAudio,
  } as const;

  if (shot.route === "grok_t2v") {
    if (shot.startFrame) throw invalid("有首帧的 shot 必须走 I2V");
    assertGeneratedDuration(shot.durationSec);
    return {
      ...base,
      mode: "text_to_video",
      model: MODEL_1_5,
      durationSec: shot.durationSec,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    };
  }

  if (shot.route === "grok_i2v") {
    if (!shot.startFrame) throw invalid("I2V 需要 startFrame");
    assertGeneratedDuration(shot.durationSec);
    return {
      ...base,
      mode: "image_to_video",
      model: MODEL_1_5,
      durationSec: shot.durationSec,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      startImage: resolveAsset(shot.startFrame.assetId),
    };
  }

  if (shot.route === "grok_r2v") {
    assertGeneratedDuration(shot.durationSec);
    const assetIds = referenceAssetIds(shot, bible);
    if (!assetIds.length) throw invalid("R2V 缺少参考资产");
    if (assetIds.length > 7) throw invalid("R2V 参考资产最多 7 个");
    return {
      ...base,
      mode: "reference_to_video",
      model: MODEL_1_5,
      durationSec: shot.durationSec,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: assetIds.map(resolveAsset),
    };
  }

  if (shot.route === "grok_extend") {
    if (shot.continuity !== "extend") throw invalid("Extend 必须使用 extend 连续性");
    assertExtendDuration(shot.durationSec);
    if (!input.sourceVideo || input.sourceVideo.kind !== "file_id" || !input.sourceVideo.fileId) {
      throw invalid("Extend 必须使用 file_id");
    }
    return {
      ...base,
      mode: "extend_video",
      model: MODEL_1_0,
      durationSec: shot.durationSec,
      sourceVideo: input.sourceVideo,
    };
  }

  throw invalid(`未知 shot 路由: ${shot.route}`);
}

function referenceAssetIds(shot: Shot, bible: IdentityBible): string[] {
  const ids: string[] = [];
  for (const characterId of shot.characterIds) {
    const character = bible.characters.find((item) => item.id === characterId);
    if (!character) throw invalid(`R2V 角色不存在: ${characterId}`);
    ids.push(...character.sheetAssetIds);
  }
  if (shot.locationId) {
    const location = bible.locations.find((item) => item.id === shot.locationId);
    if (!location) throw invalid(`R2V 场景不存在: ${shot.locationId}`);
    ids.push(...location.refAssetIds);
  }
  return [...new Set(ids)];
}

function assertContinuity(shot: Shot) {
  if (shot.continuity === "extend" && shot.route !== "grok_extend") {
    throw invalid("extend 连续性必须使用 grok_extend");
  }
  if (shot.route === "grok_extend" && shot.continuity !== "extend") {
    throw invalid("grok_extend 必须使用 extend 连续性");
  }
  if (shot.continuity === "tail_chain" && shot.route !== "grok_i2v") {
    throw invalid("tail-chain 必须使用 I2V");
  }
}

function assertGeneratedDuration(durationSec: number) {
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 15) {
    throw invalid("生成 shot 时长须为 1–15 秒整数");
  }
}

function assertExtendDuration(durationSec: number) {
  if (!Number.isInteger(durationSec) || durationSec < 2 || durationSec > 10) {
    throw invalid("Extend shot 时长须为 2–10 秒整数");
  }
}

function invalid(message: string): ProviderHttpError {
  return new ProviderHttpError(400, "invalid_argument", message);
}
