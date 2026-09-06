import {
  forceMock,
  hasKlingKey,
  hasOpenaiKey,
  hasXaiKey,
  hasYmanKey,
  imageProviderOrder,
  klingVideoAudio,
  videoProviderOrder,
} from "@/lib/env";
import { isExhausted } from "@/lib/providers/exhaustion";
import { grokNativeProvider } from "@/lib/providers/grok/native";
import { isHarnessDuration } from "@/lib/providers/grok/mode-matrix";
import { klingProvider } from "@/lib/providers/kling/native";
import { mockProvider } from "@/lib/providers/mock";
import { jimengProvider } from "@/lib/providers/jimeng";
import { openaiImageProvider } from "@/lib/providers/openai-image/native";
import { ymanProvider } from "@/lib/providers/yman/native";
import { ProviderHttpError } from "@/lib/providers/types";
import type {
  AspectRatio,
  NativeMode,
  ProviderGenerateRequest,
  ProviderId,
  VideoProvider,
} from "@/lib/providers/types";

/**
 * 一个 provider 有没有可用的 key。路由第一关问的就是它——没有 key 的 provider
 * 无论排在多前面都不参与。
 */
export function hasProviderKey(id: ProviderId): boolean {
  switch (id) {
    case "grok":
      return hasXaiKey();
    case "kling":
      return hasKlingKey();
    case "yman":
      return hasYmanKey();
    case "openai":
      return hasOpenaiKey();
    case "mock":
      return true;
    // 即梦还是占位实现（submit 直接抛），永远不该被自动路由选中。
    case "jimeng":
      return false;
  }
}

/** 这个 provider 接不接得下这个画幅。没声明 `aspectRatios` = 不限（xAI / mock）。 */
function servesRatio(provider: VideoProvider, aspectRatio?: AspectRatio): boolean {
  if (!aspectRatio) return true;
  const ratios = provider.capabilities().aspectRatios;
  return !ratios || ratios.includes(aspectRatio);
}

const NO_PROVIDER_FOR_RATIO = "当前画幅暂无可用的生成服务";

/**
 * 视频路由（方案 §3.4「功能先于供应商」）：按 `VIDEO_PROVIDER_ORDER` 的次序，取第一个
 * 「配了 key、没被判定积分耗尽、`capabilities().modes` 声明支持这个模式、且接得下请求
 * 画幅」的 provider，而不是按某个开关点名。所以 `edit_video` / `extend_video` 只有 grok
 * 声明支持，自然落回 grok；1:1 的请求在 `yman,kling` 下自然落到可灵。
 *
 * 时长不参与筛选：秒数允许向上归一（4→5，上游按档计费，多给不少给）。画幅参与，
 * 因为竖屏换横屏不是归一，是交付了另一个东西。
 *
 * 一个都没选中时分两种：
 *  - 这个**模式**没人接（r2v / edit / extend）：照旧回落 grok（能力最全），没 key 才 mock。
 *  - 模式接得了、**画幅**接不了：返回 null，由调用方 400。回落等于替用户把画幅换成
 *    另一家的默认值，而这正是这次要杜绝的静默改写。
 */
function pickVideoProvider(mode: NativeMode, aspectRatio?: AspectRatio): VideoProvider | null {
  let ratioBlocked = false;
  for (const id of videoProviderOrder()) {
    if (!hasProviderKey(id) || isExhausted(id, "video")) continue;
    const provider = providerForId(id);
    if (!provider.capabilities().modes.includes(mode)) continue;
    if (!servesRatio(provider, aspectRatio)) {
      ratioBlocked = true;
      continue;
    }
    return provider;
  }
  if (ratioBlocked) return null;
  return hasXaiKey() ? grokNativeProvider : mockProvider;
}

/**
 * 文生图路由：按 `IMAGE_PROVIDER_ORDER`（默认 `openai,grok`，即加 YMan 之前那条硬编码
 * 阶梯）取第一个「有 key、没耗尽、声明 text_to_image」的 provider，都没有才 mock。
 * 画幅不参与——三条生图通道都能出全部七个画幅。
 */
function pickImageProvider(): VideoProvider {
  for (const id of imageProviderOrder()) {
    if (!hasProviderKey(id) || isExhausted(id, "image")) continue;
    const provider = providerForId(id);
    if (provider.capabilities().modes.includes("text_to_image")) return provider;
  }
  return mockProvider;
}

/**
 * 这次请求该交给谁。
 *
 * 视频模式走 `pickVideoProvider` 的「能力 + 优先级」；30 / 45 / 60 秒长片例外——它由一致性
 * 管线拆成多个 shot 交给 xAI（extend 依赖 Files API），别家接不了，所以恒定留在 grok。
 * 没有任何一家接得下请求画幅时抛 400，而不是悄悄换一个画幅出片。
 */
export function selectProvider(req?: ProviderGenerateRequest): VideoProvider {
  if (forceMock()) return mockProvider;
  if (req?.mode === "text_to_image") return pickImageProvider();
  if (isHarnessDuration(req?.durationSec)) {
    return hasXaiKey() ? grokNativeProvider : mockProvider;
  }
  const provider = pickVideoProvider(req?.mode ?? "text_to_video", req?.aspectRatio);
  if (!provider) throw new ProviderHttpError(400, "invalid_argument", NO_PROVIDER_FOR_RATIO);
  return provider;
}

/**
 * `opts.harness` 是调用方（`create.ts`）判定的长片标记，与 `selectProvider` 里的
 * `isHarnessDuration` 同义：长片一律留在 grok。`aspectRatio` 让「先算 provider、再按它
 * 归一参数」的调用方（`create.ts` / runner 的换家）拿到与 `selectProvider` 一致的答案。
 */
export function currentProviderId(
  mode?: NativeMode,
  opts?: { harness?: boolean; aspectRatio?: AspectRatio; durationSec?: number },
): ProviderId {
  if (forceMock()) return "mock";
  if (mode === "text_to_image") return pickImageProvider().id;
  if (opts?.harness || isHarnessDuration(opts?.durationSec)) {
    return hasXaiKey() ? "grok" : "mock";
  }
  const provider = pickVideoProvider(mode ?? "text_to_video", opts?.aspectRatio);
  if (!provider) throw new ProviderHttpError(400, "invalid_argument", NO_PROVIDER_FOR_RATIO);
  return provider.id;
}

export function providerForId(id: VideoProvider["id"]): VideoProvider {
  if (id === "mock") return mockProvider;
  if (id === "grok") return grokNativeProvider;
  if (id === "jimeng") return jimengProvider;
  if (id === "openai") return openaiImageProvider;
  if (id === "kling") return klingProvider;
  if (id === "yman") return ymanProvider;
  throw new Error(`unknown provider: ${String(id)}`);
}

/** 时长连续（grok / mock）时芯片显示的几档。 */
const DEFAULT_VIDEO_DURATIONS: readonly number[] = [4, 6, 8, 10];

/**
 * 首页时长芯片该显示哪几档（方案 §3.4「功能先于供应商」：功能照常露出，供应商差异
 * 在这里吸收）。上游按档计费，芯片上只能出现「会被计费的那个时长」——判据是 provider
 * 自己声明的 `capabilities().durations`（没声明 = 时长连续，用默认那几档），服务端解析
 * 一次下发，浏览器看不见 `YMAN_T2V_MODEL` 之类的变量。
 *
 * 30 / 45 / 60 从这里剔掉：它们是一致性管线的长片档，由 `harnessEnabled()` 单独追加，
 * 未开启时 API 会 400。剔完空了（某个模型只有长片档）就退回原表，宁可露出也不留空。
 */
export function videoDurationsFor(providerId: ProviderId): readonly number[] {
  const raw = providerForId(providerId).capabilities().durations ?? DEFAULT_VIDEO_DURATIONS;
  const usable = raw.filter((d) => !isHarnessDuration(d));
  return usable.length ? usable : raw;
}

/** 首页画幅芯片的顺序，也是它认得的全集。 */
const UI_VIDEO_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];

/**
 * 首页画幅芯片该显示哪几个：ORDER 里所有**有 key** 的视频 provider 支持画幅的并集。
 *
 * 并集而不是第一顺位那一家：路由本来就会按画幅挑人，只要有一家接得下 1:1，这个芯片就
 * 该露出来。反过来，一家都接不下的画幅必须从芯片上消失——留着它等于让用户选一个提交
 * 就会 400 的东西。有 provider 不声明画幅（xAI / mock，什么都收）时直接给全集。
 */
export function videoAspectRatios(): AspectRatio[] {
  if (forceMock()) return [...UI_VIDEO_RATIOS];
  const allowed = new Set<AspectRatio>();
  let sawKeyedProvider = false;
  for (const id of videoProviderOrder()) {
    if (!hasProviderKey(id)) continue;
    const caps = providerForId(id).capabilities();
    if (!caps.modes.includes("text_to_video")) continue;
    sawKeyedProvider = true;
    if (!caps.aspectRatios) return [...UI_VIDEO_RATIOS];
    for (const ratio of caps.aspectRatios) allowed.add(ratio);
  }
  if (!sawKeyedProvider) return [...UI_VIDEO_RATIOS];
  const out = UI_VIDEO_RATIOS.filter((ratio) => allowed.has(ratio));
  // 全被筛没了（配置错到没有一家能出这三个画幅中的任何一个）就退回全集：
  // 芯片留空是个死界面，露出来至少还能拿到一句明确的 400。
  return out.length ? out : [...UI_VIDEO_RATIOS];
}

/**
 * 音轨能力的唯一判据，`src/app/page.tsx` 与 `/api/health` 共用（两处分叉就会出现
 * 「界面能选、上游不出声」）。
 *
 * 可灵由 `KLING_VIDEO_AUDIO` 决定（默认 off，上游只在 1080p 出声）；YMan 为 false 表示
 * **不可控**——它的建任务接口根本没有音频参数，出不出声由模型自己决定，所以既不能保证
 * 有声，也不该向用户收有声的加价。grok / mock 一直支持。
 */
export function audioAvailableFor(providerId: ProviderId): boolean {
  if (providerId === "kling") return klingVideoAudio() === "native";
  if (providerId === "yman") return false;
  return true;
}

export function needsSourceFileUpload(
  providerId: VideoProvider["id"],
  mode: ProviderGenerateRequest["mode"],
): boolean {
  return providerId === "grok" && (mode === "edit_video" || mode === "extend_video");
}
