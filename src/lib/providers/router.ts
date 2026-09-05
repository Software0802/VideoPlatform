import { forceMock, hasOpenaiKey, hasXaiKey } from "@/lib/env";
import { grokNativeProvider } from "@/lib/providers/grok/native";
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
 */
export function selectProvider(req?: ProviderGenerateRequest): VideoProvider {
  if (forceMock()) return mockProvider;
  if (req?.mode === "text_to_image") {
    if (hasOpenaiKey()) return openaiImageProvider;
    if (hasXaiKey()) return grokNativeProvider;
    return mockProvider;
  }
  if (hasXaiKey()) return grokNativeProvider;
  return mockProvider;
}

export function currentProviderId(mode?: NativeMode): ProviderId {
  if (forceMock()) return "mock";
  if (mode === "text_to_image") {
    if (hasOpenaiKey()) return "openai";
    if (hasXaiKey()) return "grok";
    return "mock";
  }
  return hasXaiKey() ? "grok" : "mock";
}

export function providerForId(id: VideoProvider["id"]): VideoProvider {
  if (id === "mock") return mockProvider;
  if (id === "grok") return grokNativeProvider;
  if (id === "jimeng") return jimengProvider;
  if (id === "openai") return openaiImageProvider;
  throw new Error(`unknown provider: ${String(id)}`);
}

export function needsSourceFileUpload(
  providerId: VideoProvider["id"],
  mode: ProviderGenerateRequest["mode"],
): boolean {
  return providerId === "grok" && (mode === "edit_video" || mode === "extend_video");
}
