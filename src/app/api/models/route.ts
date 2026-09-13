import { estimateCostUsd } from "@/lib/cost";
import { usdCnyRate } from "@/lib/env";
import { jsonError } from "@/lib/http";
import {
  availableProducts,
  defaultResolutionOf,
  modelForProduct,
  samplePriceCny,
  type Product,
} from "@/lib/products/catalog";
import { relayViewFor } from "@/lib/providers/relay/live";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 这一刻用户能选的产品（`src/lib/products/catalog.ts`）。
 *
 * 只列**可用**的：provider 在这条通道的 ORDER 里、配了 key、没被判定积分耗尽。列一个
 * 提交就会 400 / 503 的产品比不列更糟。`samplePriceCny` 是标价牌（视频按 5 秒 + 产品
 * 默认档，图片按 1K），真实售价仍在提交时按归一后的参数重算——两处用的是同一张
 * `billing/prices.ts` 的表。
 *
 * 字段是**白名单挑出来**的，不是 `{...product}`。`providerId` / `providerName` /
 * `upstreamModel`（展示名）自 N3.3 起随 DTO 下发，供创作面板按供应商分组与展示
 * 成本档（方案 `plan-relay-provider` §3.4）；key、错误详情等仍不出网。
 * 加字段时同步 `src/lib/client/models.ts` 的镜像类型。
 */
/** 内建 provider 的展示名；relay 的展示名读它的视图（管理接口里登记的那个名字）。 */
const BUILTIN_PROVIDER_NAMES: Record<string, string> = {
  grok: "Grok",
  kling: "Kling",
  mock: "Mock",
  jimeng: "Jimeng",
  openai: "OpenAI",
  yman: "YMan",
};

function providerNameOf(provider: string): string {
  return relayViewFor(provider)?.name ?? BUILTIN_PROVIDER_NAMES[provider] ?? provider;
}

/**
 * 标价牌背后的上游成本档：估算成本折人民币相对售价的比值 <0.3 → low、<0.6 → mid、
 * 其余 high；估不出（异常 / 除零 / 非有限数）记 "mid"，不让一个估不准的模型把档标丢。
 */
function costHintOf(product: Product, samplePrice: number): "low" | "mid" | "high" {
  try {
    const model = modelForProduct(product, product.modes[0] ?? "text_to_video");
    const usd =
      product.kind === "image"
        ? estimateCostUsd(model, 0, {
            size: "1024x1024",
            quality: "medium",
            provider: product.provider,
          })
        : estimateCostUsd(model, product.durations?.[0] ?? 5, undefined, {
            provider: product.provider,
            resolution: defaultResolutionOf(product) ?? "720p",
            audio: product.audio === "native" ? "native" : "off",
          });
    const ratio = (usd * usdCnyRate()) / samplePrice;
    if (!Number.isFinite(ratio) || ratio <= 0) return "mid";
    if (ratio < 0.3) return "low";
    if (ratio < 0.6) return "mid";
    return "high";
  } catch {
    return "mid";
  }
}

function toPublicProduct(product: Product) {
  const price = samplePriceCny(product);
  return {
    id: product.id,
    name: product.name,
    kind: product.kind,
    modes: product.modes,
    resolutions: product.resolutions,
    defaultResolution: defaultResolutionOf(product),
    aspectRatios: product.aspectRatios,
    durations: product.durations,
    audio: product.audio,
    supportsLastFrame: product.supportsLastFrame,
    supportsLongForm: product.supportsLongForm,
    maxReferenceImages: product.maxReferenceImages,
    imageResolutions: product.imageResolutions,
    providerId: product.provider,
    providerName: providerNameOf(product.provider),
    upstreamModel: product.upstreamModel ?? modelForProduct(product, product.modes[0] ?? "text_to_video"),
    costHint: costHintOf(product, price),
    description: product.description,
    samplePriceCny: price,
  };
}

export async function GET(request: Request) {
  try {
    await requireUser(request);
    return Response.json({ products: availableProducts().map(toPublicProduct) });
  } catch (e) {
    return jsonError(e);
  }
}
