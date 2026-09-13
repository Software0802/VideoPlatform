import { klingVideoModel, openaiImageModel, ymanImageModel } from "@/lib/env";
import { modelForMode } from "@/lib/providers/grok/mode-matrix";
import { relayViewFor } from "@/lib/providers/relay/live";
import { modelFor as ymanModelFor } from "@/lib/providers/yman/catalog";
import type { NativeMode, ProviderId } from "@/lib/providers/types";

/**
 * 这台实例按**环境变量**给这家 provider 定的上游模型名（不看产品）。
 *
 * 单独成模块，是因为它有两个调用方，而它们互为上下游：
 *  - `jobs/provider-settings.ts` 的 `modelForProvider`（没点名产品时的模型名）；
 *  - `products/catalog.ts` 的 `modelForProduct`（产品没写死 `model` 时的回落）。
 *
 * 让后者 import 前者会绕成 catalog ↔ provider-settings 的循环依赖，把这段判断留在
 * 两边各抄一份又会漂移——运维改 `KLING_VIDEO_MODEL` 时只有一半生效，是最难查的那种。
 */
export function envModelFor(provider: ProviderId, mode: NativeMode): string {
  if (provider === "kling") return klingVideoModel();
  // relay（含 yman / openai 两个 env 预设）：视频走它的目录（`defaults` / 展示名
  // 归一），生图走 `image.model`——与旧 `OPENAI_IMAGE_MODEL` / `YMAN_IMAGE_MODEL`
  // 分支逐字同义，那两个预设的 model() 读的就是同一个 env。
  const relay = relayViewFor(provider);
  if (relay) {
    if (mode === "text_to_image") {
      return relay.image?.model() ?? modelForMode(mode);
    }
    return relay.catalog?.modelFor(mode) ?? modelForMode(mode);
  }
  // 视图还没装配（单测只 import 本文件）时，两个 env 预设走原来的分支。
  if (provider === "openai") return openaiImageModel();
  if (provider === "yman") return mode === "text_to_image" ? ymanImageModel() : ymanModelFor(mode);
  return modelForMode(mode);
}
