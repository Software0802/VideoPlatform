import type { VideoPricingHint } from "@/lib/cost";
import { defaultResolutionOf, modelForProduct, type Product } from "@/lib/products/catalog";
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

export function videoPricingOf(
  settings: ProviderSettings | null,
  provider: ProviderId,
): VideoPricingHint | undefined {
  return settings
    ? { resolution: settings.resolution, audio: settings.audio, provider }
    : undefined;
}
