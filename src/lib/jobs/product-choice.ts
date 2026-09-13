import { isMockMode } from "@/lib/env";
import {
  isProductAvailable,
  productById,
  productForProvider,
  productServesResolution,
  type Product,
} from "@/lib/products/catalog";
import { isHarnessDuration } from "@/lib/harness/durations";
import { currentProviderId, providerForId } from "@/lib/providers/router";
import { ProviderHttpError } from "@/lib/providers/types";
import type {
  AspectRatio,
  ImageResolution,
  NativeMode,
  ProviderId,
  Resolution,
} from "@/lib/providers/types";

/**
 * 「这次任务交给谁、挂哪个产品名」——`createJob` 与 `retryJob` 共用的一步。
 *
 * 两条路：
 *  - 用户点名了产品（请求体的 `model` 是**产品 id**）：provider 与上游模型由产品决定，
 *    绕过 `VIDEO_PROVIDER_ORDER`。产品不存在 / 当前不可用 / 接不下这次的 mode、画幅、
 *    分辨率、尾帧、参考图数量时一律 400——静默换一个产品等于交付了用户没点的东西。
 *  - 没点名：沿用既有的能力路由，再按选中的 provider 给任务打上产品标签（`product`）。
 *    这条路上模型名仍由环境变量决定（`modelForProvider`），产品只是界面上的名字——
 *    运维把 `YMAN_T2V_MODEL` 换成另一个模型时，不该被产品表悄悄改回去。
 */
export type ProductChoice = { provider: ProviderId; product?: Product };

export type ChooseProductInput = {
  mode: NativeMode;
  /** 请求体里的 `model`，即产品 id。 */
  requestedId?: string;
  harness: boolean;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  imageResolution?: ImageResolution;
  needsLastFrame: boolean;
  referenceCount: number;
  durationSec?: number;
};

const UNAVAILABLE = "所选模型当前不可用";

export function chooseProduct(input: ChooseProductInput): ProductChoice {
  const requested = input.requestedId?.trim();
  if (!requested) {
    // 能力路由自己会为「画幅 / 分辨率 / 尾帧没人接得下」抛 400。
    const provider = currentProviderId(input.mode, {
      harness: input.harness,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      needsLastFrame: input.needsLastFrame,
      durationSec: input.durationSec,
    });
    return { provider };
  }

  const product = productById(requested);
  if (!product || !isProductAvailable(product)) {
    throw new ProviderHttpError(400, "invalid_argument", UNAVAILABLE);
  }
  assertProductFits(product, input);
  // mock 实例（没有任何真 key，或 `LUMEN_FORCE_MOCK`）拿 mock 回答一切——路由的兜底
  // 也是这么落的。产品标签照留：界面显示的仍是用户点的那一档，只是背后没有真上游。
  return { provider: isMockMode() ? "mock" : product.provider, product };
}

/** 用户点名的产品接不接得下这次请求。每一条都是他自己点过的东西，不能靠改写来满足。 */
function assertProductFits(product: Product, input: ChooseProductInput): void {
  const harness = input.harness || isHarnessDuration(input.durationSec);
  if (harness) {
    // 30 / 45 / 60 秒是一致性管线的长片：管线会把任务拆成 t2v + i2v 两类 shot，
    // 产品背后那家必须两条 mode 都声明（例如可灵、YMan；jimeng 只占位不算），且产品
    // 自己声明 supportsLongForm、时长档收得下单段 10 秒。
    const modes = providerForId(product.provider).capabilities().modes;
    if (
      !modes.includes("text_to_video") ||
      !modes.includes("image_to_video") ||
      !product.supportsLongForm ||
      (product.durations?.length ? !product.durations.includes(10) : false)
    ) {
      throw new ProviderHttpError(
        400,
        "invalid_argument",
        "所选模型不支持 30 / 45 / 60 秒长片",
      );
    }
  }
  if (!product.modes.includes(input.mode)) {
    throw new ProviderHttpError(400, "invalid_argument", "所选模型不支持这种生成方式");
  }
  if (input.aspectRatio && !product.aspectRatios.includes(input.aspectRatio)) {
    throw new ProviderHttpError(400, "invalid_argument", "所选模型不支持该画幅");
  }
  // 时长只允许**向上**归一（4 秒的请求按 5 秒那一档下单，多给不少给）。超过最长的那一档
  // 就没有归一可言了：10 秒档的模型接一条 15 秒的请求，只能交付 10 秒——那是另一个东西，
  // 而用户会照 15 秒被报价。`durations` 省略 = 时长连续（grok），不在这条判据里。
  // 长片的 30/45/60 是管线目标总长，单段已在上面按 10 秒档校验过，不与产品时长档比较。
  if (!harness && product.durations?.length && input.durationSec != null) {
    const longest = Math.max(...product.durations);
    if (input.durationSec > longest) {
      throw new ProviderHttpError(400, "invalid_argument", "所选模型不支持该时长");
    }
  }
  if (product.kind === "video" && !productServesResolution(product, input.resolution)) {
    throw new ProviderHttpError(400, "invalid_argument", "所选模型不支持该分辨率");
  }
  if (
    product.kind === "image" &&
    input.imageResolution &&
    product.imageResolutions &&
    !product.imageResolutions.includes(input.imageResolution)
  ) {
    throw new ProviderHttpError(400, "invalid_argument", "所选模型不支持该图片分辨率");
  }
  if (input.needsLastFrame && !product.supportsLastFrame) {
    throw new ProviderHttpError(400, "invalid_argument", "当前模型不支持首尾帧");
  }
  if (input.referenceCount > product.maxReferenceImages) {
    throw new ProviderHttpError(
      400,
      "invalid_argument",
      product.maxReferenceImages > 0
        ? `所选模型最多支持 ${product.maxReferenceImages} 张参考图`
        : "所选模型不支持参考图",
    );
  }
}

/**
 * 没点名产品时给任务打标签：按已经选定的 provider 与解析出的上游模型找回对应的产品。
 * 找不到（mock 实例、或这家没有对应产品）就不打——记录里没有产品名，界面回落显示模式名，
 * 比编一个不对的名字好。
 */
export function labelProduct(
  choice: ProductChoice,
  mode: NativeMode,
  model: string,
): Product | undefined {
  return choice.product ?? productForProvider(choice.provider, mode, model);
}
