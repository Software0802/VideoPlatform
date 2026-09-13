import { ProviderHttpError, type MediaRef, type ProviderGenerateRequest, type VideoProvider } from "@/lib/providers/types";
import type { IdentityBible, Shot } from "./types";

export type ShotAssetResolver = (assetId: string) => MediaRef;

export type ProviderCaps = ReturnType<VideoProvider["capabilities"]>;

export type BuildShotRequestInput = {
  jobId: string;
  shot: Shot;
  bible: IdentityBible;
  resolveAsset: ShotAssetResolver;
  /** 任务落定时选定的上游模型名（job.model），shot 不再自己挑模型。 */
  model: string;
  /** 执行这条 shot 的 provider 能力；时长档与参考图上限按它校验。 */
  caps: ProviderCaps;
  aspectRatio?: ProviderGenerateRequest["aspectRatio"];
  resolution?: ProviderGenerateRequest["resolution"];
};

/**
 * shot 路由（t2v / i2v / r2v）到原生 mode 的映射，供应商无关：
 * 选哪家 provider、用什么模型在任务创建时已经定了，这里只按那家声明的能力校验参数。
 */
export function buildShotRequest(input: BuildShotRequestInput): ProviderGenerateRequest {
  const { jobId, shot, bible, resolveAsset, model, caps } = input;
  if (!jobId.trim()) throw invalid("shot jobId 无效");
  if (!model.trim()) throw invalid("shot model 无效");
  assertContinuity(shot);

  const base = {
    jobId: `${jobId}-shot-${shot.index}`,
    prompt: shot.prompt,
    generateAudio: shot.generateAudio,
  } as const;

  if (shot.route === "t2v") {
    if (shot.startFrame) throw invalid("有首帧的 shot 必须走 I2V");
    assertShotDuration(shot.durationSec, caps);
    return {
      ...base,
      mode: "text_to_video",
      model,
      durationSec: shot.durationSec,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    };
  }

  if (shot.route === "i2v") {
    if (!shot.startFrame) throw invalid("I2V 需要 startFrame");
    assertShotDuration(shot.durationSec, caps);
    return {
      ...base,
      mode: "image_to_video",
      model,
      durationSec: shot.durationSec,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      startImage: resolveAsset(shot.startFrame.assetId),
    };
  }

  if (shot.route === "r2v") {
    assertShotDuration(shot.durationSec, caps);
    let assetIds = referenceAssetIds(shot, bible);
    const max = caps.maxReferenceImages;
    if (max === 0) throw invalid("当前 provider 不收参考图");
    // 参考图超上限时按声明顺序截断——角色表在前、场景参考在后（角色表是身份锁定项）。
    if (max != null && assetIds.length > max) assetIds = assetIds.slice(0, max);
    if (!assetIds.length) throw invalid("R2V 缺少参考资产");
    return {
      ...base,
      mode: "reference_to_video",
      model,
      durationSec: shot.durationSec,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: assetIds.map(resolveAsset),
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
  if (shot.continuity === "tail_chain" && shot.route !== "i2v") {
    throw invalid("tail-chain 必须使用 I2V");
  }
}

/** shot/clip 时长恒为 5 / 10 秒档；provider 声明了档表时还必须真收这一档。 */
function assertShotDuration(durationSec: number, caps: ProviderCaps) {
  if (durationSec !== 5 && durationSec !== 10) {
    throw invalid("shot 时长须为 5 或 10 秒");
  }
  if (caps.durations?.length && !caps.durations.includes(durationSec)) {
    throw invalid("当前 provider 不支持该时长档");
  }
  if (!caps.durations?.length && durationSec > caps.maxDurationSec) {
    throw invalid("当前 provider 不支持该时长档");
  }
}

function invalid(message: string): ProviderHttpError {
  return new ProviderHttpError(400, "invalid_argument", message);
}
