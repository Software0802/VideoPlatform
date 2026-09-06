import { jsonError } from "@/lib/http";
import {
  availableProducts,
  defaultResolutionOf,
  samplePriceCny,
  type Product,
} from "@/lib/products/catalog";
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
 * 字段是**白名单挑出来**的，不是 `{...product}`：产品记录里还有 `provider` 与上游
 * `model`，它们绝不能出网（用户 2026-09-06 的决定：只露产品名，不露供应商）。要登录
 * 才看得到不算防线——排查用的那两项去看服务器日志与 `job.json`，浏览器不需要。
 * 加字段时同步 `src/lib/client/models.ts` 的镜像类型。
 */
function toPublicProduct(product: Product) {
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
    description: product.description,
    samplePriceCny: samplePriceCny(product),
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
