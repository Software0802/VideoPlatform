import {
  estimateCostUsd,
  estimateHarnessCostUsd,
  LLM_RESERVE_USD,
  type HarnessClip,
  type VideoPricingHint,
} from "@/lib/cost";
import { defaultResolutionOf, modelForProduct, type Product } from "@/lib/products/catalog";
import { imageConfigFor } from "@/lib/providers/openai-image/config";
import { mapAspectToSize } from "@/lib/providers/openai-image/rest-map";
import { selectProvider } from "@/lib/providers/router";
import { resolveKlingSettings } from "@/lib/providers/kling/rest-map";
import { envModelFor } from "@/lib/providers/model-name";
import { type YmanResolution } from "@/lib/providers/yman/catalog";
import { resolveYmanSettings } from "@/lib/providers/yman/rest-map";
import type { AspectRatio, NativeMode, ProviderId, Resolution } from "@/lib/providers/types";
import type { CreateJobBody } from "@/lib/jobs/schema";

/**
 * 「选定 provider 后，这次调用的参数该长什么样」。
 *
 * 从 `create.ts` 提出来，是为了让 runner 在「某家积分耗尽、任务改走另一家」时能用同一套
 * 归一逻辑重算 model / 时长 / 分辨率 / 估价——runner 不能 import `create.ts`（那边有队列
 * 准入、配额、素材认领这些只属于建任务的副作用）。
 */

/**
 * Model名与 provider 必须同源：具体那张对照表在 `providers/model-name.ts` 的
 * `envModelFor`（OpenAI 生图 OPENAI_IMAGE_MODEL、可灵 KLING_VIDEO_MODEL、YMan 视频用
 * 它的展示名目录、YMan 生图 YMAN_IMAGE_MODEL，其余按 mode 走 Grok 矩阵）。
 * 对既有的 grok / mock 任务，本函数与 `modelForMode` 结果完全一致。
 */
export function modelForProvider(
  provider: ProviderId,
  mode: NativeMode,
  product?: Product | null,
): string {
  // 用户点名了产品，且这次真的由它的 provider 执行：模型名以产品为准。
  // provider 与产品对不上（mock 实例、换家之后）时不能用产品的模型名——那会把一个
  // 别家的模型名写进记录，日志、账目、重试全跟着错。
  if (product && product.provider === provider) return modelForProduct(product, mode);
  return envModelFor(provider, mode);
}

/**
 * 一次视频调用**归一到上游档位后**的参数，与 provider 无关的那部分。
 * `null` 表示这个 provider 不需要归一（grok / mock 按请求原样发）。
 */
export type ProviderSettings = {
  durationSec: number;
  resolution: "720p" | "1080p";
  audio: "off" | "native";
  ratio?: AspectRatio;
};

/**
 * 选中的 provider 接得下这个任务时给出归一后的参数，否则 null（调用方按原逻辑走）。
 * 只有 provider 真的被选中、且是它声明支持的视频模式时才归一——别家的记录不能被
 * 这家的枚举改写。
 */
export function providerSettingsFor(
  provider: ProviderId,
  mode: NativeMode,
  durationSec: number | undefined,
  body: Pick<CreateJobBody, "prompt" | "aspectRatio" | "resolution" | "generateAudio">,
  model: string,
  opts?: {
    /** 用户选中的产品（或路由后打上的那个标签）。只在它的 provider 真的执行时才起作用。 */
    product?: Product | null;
    /** 这次任务带了尾帧：可灵会因此把分辨率抬到 1080p，售价必须按抬完的档算。 */
    hasLastFrame?: boolean;
  },
): ProviderSettings | null {
  const product = opts?.product && opts.product.provider === provider ? opts.product : null;
  const req = {
    jobId: "preview",
    mode,
    prompt: body.prompt,
    model,
    durationSec,
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    generateAudio: body.generateAudio ?? true,
    // 只有形状重要（是否存在），内容不会被发出去——归一发生在提交之前，此时素材还没认领。
    lastImage: opts?.hasLastFrame ? ({ kind: "path", path: "preview" } as const) : undefined,
  };
  if (provider === "kling") {
    if (mode !== "text_to_video" && mode !== "image_to_video") return null;
    const kling = resolveKlingSettings(req, {
      // 产品是「默认档」的来源，用户选了分辨率仍以用户为准（`resolveKlingSettings`）；
      // 产品没说话时才回落 `KLING_VIDEO_RESOLUTION` / `KLING_VIDEO_AUDIO`。
      resolution: klingResolution(product),
      audio: product ? (product.audio === "native" ? "native" : "off") : undefined,
    });
    return { durationSec: kling.durationSec, resolution: kling.resolution, audio: kling.audio };
  }
  if (provider === "yman") {
    if (mode !== "text_to_video" && mode !== "image_to_video" && mode !== "reference_to_video") {
      return null;
    }
    const yman = resolveYmanSettings(req, { resolution: ymanResolution(product) });
    // YMan 的建任务接口没有音频开关（出不出声由模型决定），所以记录一律记无声：
    // 记成有声就是拿一个我们控制不了的东西向用户收有声的加价。
    return {
      durationSec: yman.durationSec,
      resolution: yman.resolution,
      audio: "off",
      ratio: yman.ratio,
    };
  }
  return null;
}

/** 产品默认档收窄到可灵出得了的两档；产品没说话（或不是可灵的产品）时返回 undefined。 */
function klingResolution(product: Product | null): "720p" | "1080p" | undefined {
  const preferred = product ? defaultResolutionOf(product) : undefined;
  return preferred === "1080p" || preferred === "720p" ? preferred : undefined;
}

/** 同上，收窄到 YMan 的两档。 */
function ymanResolution(product: Product | null): YmanResolution | undefined {
  const preferred: Resolution | undefined = product ? defaultResolutionOf(product) : undefined;
  return preferred === "1080p" || preferred === "720p" ? preferred : undefined;
}

/**
 * 长片（harness）任务的归一参数：30/45/60 是管线内部拆 shot 的目标总长，不能拿它去问
 * provider 的时长档（可灵会把 30 归一成 10，记录就被写坏了）。这里用一段合法的 clip
 * 时长拿到 resolution / audio / ratio 的归一结果，durationSec 由调用方保留目标总长。
 */
export type HarnessSettings = Omit<ProviderSettings, "durationSec">;

export function harnessSettingsFor(
  provider: ProviderId,
  mode: NativeMode,
  body: Pick<CreateJobBody, "prompt" | "aspectRatio" | "resolution" | "generateAudio">,
  model: string,
  opts?: Parameters<typeof providerSettingsFor>[5],
): HarnessSettings | null {
  const settings = providerSettingsFor(provider, mode, 10, body, model, opts);
  if (!settings) return null;
  const { durationSec, ...rest } = settings;
  void durationSec;
  return rest;
}

/**
 * 长片在视频片段之外的固定开销预留：单角色三视图 + 一镜首帧的经验值。
 * 多角色 / 多 hard_cut 镜会超出——届时 `costOverTarget` 软线与 ×2 硬上限照常告警，
 * 估价的职责是把常态情形估到不离谱，不是封顶。
 */
export const HARNESS_IMAGE_SHOT_COUNT = 4;

/**
 * 4 张 16:9/1k 图按「当前 IMAGE_PROVIDER_ORDER 首选 provider」的口径估价，与
 * orchestrator 里 `sheetPrice` 同一条公式（`mapAspectToSize` + 通道 quality）。
 * 没有生图 provider（或只剩 mock）时为 0——估不出来不等于免费，只是这里不预加。
 */
export function harnessImageAllowanceUsd(): number {
  let provider: ReturnType<typeof selectProvider>;
  try {
    provider = selectProvider({
      jobId: "harness-estimate",
      mode: "text_to_image",
      prompt: "",
      model: "",
      generateAudio: false,
    });
  } catch {
    return 0;
  }
  if (provider.id === "mock") return 0;
  const imageModel = modelForProvider(provider.id, "text_to_image");
  const imageShape = imageConfigFor(provider.id)?.shape();
  const each = estimateCostUsd(imageModel, 0, {
    size: mapAspectToSize("16:9", "1k", imageShape).size,
    quality: imageShape?.quality ?? "high",
    provider: provider.id,
  });
  return Math.round(each * HARNESS_IMAGE_SHOT_COUNT * 100) / 100;
}

/**
 * 长片提交时的完整成本预估 = 视频片段计价 + Director 预留 + 角色表/首帧生图预留。
 * 只算视频片段会系统性低估（实测 30s 估 $0.9 / 实付 $1.45），低估值会提前撞
 * `costOverTarget` 软线甚至 ×2 硬上限把正常任务停掉。
 */
export function harnessSubmitEstimateUsd(
  clips: readonly HarnessClip[],
  pricing: { model: string; video?: VideoPricingHint },
): number {
  return estimateHarnessCostUsd(clips, pricing) + LLM_RESERVE_USD.director + harnessImageAllowanceUsd();
}

export function videoPricingOf(
  settings: Pick<ProviderSettings, "resolution" | "audio"> | null,
  provider: ProviderId,
): VideoPricingHint | undefined {
  return settings
    ? { resolution: settings.resolution, audio: settings.audio, provider }
    : undefined;
}
