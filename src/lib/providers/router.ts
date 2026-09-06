import { forceMock, hasKlingKey, hasOpenaiKey, hasXaiKey, videoProvider } from "@/lib/env";
import { grokNativeProvider } from "@/lib/providers/grok/native";
import { isHarnessDuration } from "@/lib/providers/grok/mode-matrix";
import { klingProvider } from "@/lib/providers/kling/native";
import { mockProvider } from "@/lib/providers/mock";
import { jimengProvider } from "@/lib/providers/jimeng";
import { openaiImageProvider } from "@/lib/providers/openai-image/native";
import type {
  NativeMode,
  ProviderGenerateRequest,
  ProviderId,
  VideoProvider,
} from "@/lib/providers/types";

/**
 * Text-to-image prefers the OpenAI official API when its key is present; everything else stays
 * on xAI. Each path falls back to mock on its own, so an instance holding only one of the two
 * keys still runs the mode that key covers for real.
 *
 * 文生视频 / 图生视频另有一条岔路：`VIDEO_PROVIDER=kling` 且配了可灵 key 时走可灵。
 * 它必须由环境变量点名而不是凭 key 存在——xAI key 会一直在（r2v / edit / extend / harness
 * 靠它），否则可灵一配上就把这些模式一起抢走了。
 */
export function selectProvider(req?: ProviderGenerateRequest): VideoProvider {
  if (forceMock()) return mockProvider;
  if (req?.mode === "text_to_image") {
    if (hasOpenaiKey()) return openaiImageProvider;
    if (hasXaiKey()) return grokNativeProvider;
    return mockProvider;
  }
  if (usesKling(req?.mode, isHarnessDuration(req?.durationSec))) return klingProvider;
  if (hasXaiKey()) return grokNativeProvider;
  return mockProvider;
}

/**
 * `opts.harness` 是调用方（`create.ts`）判定的长片标记：30 / 45 / 60 由一致性管线拆成
 * 多个 shot 交给 xAI（extend 依赖 Files API），可灵接不了，所以长片一律留在 grok。
 */
export function currentProviderId(mode?: NativeMode, opts?: { harness?: boolean }): ProviderId {
  if (forceMock()) return "mock";
  if (mode === "text_to_image") {
    if (hasOpenaiKey()) return "openai";
    if (hasXaiKey()) return "grok";
    return "mock";
  }
  if (usesKling(mode, Boolean(opts?.harness))) return "kling";
  return hasXaiKey() ? "grok" : "mock";
}

function usesKling(mode: NativeMode | undefined, harness: boolean): boolean {
  if (mode !== "text_to_video" && mode !== "image_to_video") return false;
  if (harness) return false;
  return videoProvider() === "kling" && hasKlingKey();
}

export function providerForId(id: VideoProvider["id"]): VideoProvider {
  if (id === "mock") return mockProvider;
  if (id === "grok") return grokNativeProvider;
  if (id === "jimeng") return jimengProvider;
  if (id === "openai") return openaiImageProvider;
  if (id === "kling") return klingProvider;
  throw new Error(`unknown provider: ${String(id)}`);
}

export function needsSourceFileUpload(
  providerId: VideoProvider["id"],
  mode: ProviderGenerateRequest["mode"],
): boolean {
  return providerId === "grok" && (mode === "edit_video" || mode === "extend_video");
}
