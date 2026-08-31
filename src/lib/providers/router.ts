import { isMockMode } from "@/lib/env";
import { grokNativeProvider } from "@/lib/providers/grok/native";
import { mockProvider } from "@/lib/providers/mock";
import { jimengProvider } from "@/lib/providers/jimeng";
import type { ProviderGenerateRequest, VideoProvider } from "@/lib/providers/types";

export function selectProvider(req?: ProviderGenerateRequest): VideoProvider {
  void req;
  if (isMockMode()) return mockProvider;
  return grokNativeProvider;
}

export function currentProviderId() {
  return isMockMode() ? "mock" : "grok";
}

export function providerForId(id: VideoProvider["id"]): VideoProvider {
  if (id === "mock") return mockProvider;
  if (id === "grok") return grokNativeProvider;
  if (id === "jimeng") return jimengProvider;
  throw new Error(`unknown provider: ${String(id)}`);
}

export function needsSourceFileUpload(
  providerId: VideoProvider["id"],
  mode: ProviderGenerateRequest["mode"],
): boolean {
  return providerId === "grok" && (mode === "edit_video" || mode === "extend_video");
}
