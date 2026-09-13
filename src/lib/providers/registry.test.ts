import { describe, expect, it } from "vitest";
import "@/lib/providers/builtin";
import {
  BUILTIN_PROVIDER_IDS,
  hasProviderKey,
  isRegisteredProviderId,
  providerForId,
  registerProvider,
  registeredProviderIds,
} from "@/lib/providers/registry";
import type { VideoProvider } from "@/lib/providers/types";

function fakeProvider(id: string, hasKey?: () => boolean): VideoProvider {
  return {
    id,
    hasKey,
    capabilities: () => ({
      modes: ["text_to_video"],
      maxDurationSec: 10,
      supportsLastFrameLock: false,
      maxResolution: "720p",
    }),
    submit: async () => ({ providerId: id }),
    poll: async () => ({ status: "done", progress: 100 }),
  };
}

describe("provider registry", () => {
  it("registers all builtin providers at module load", () => {
    for (const id of BUILTIN_PROVIDER_IDS) {
      expect(isRegisteredProviderId(id)).toBe(true);
      expect(providerForId(id).id).toBe(id);
    }
    for (const id of registeredProviderIds()) {
      expect(BUILTIN_PROVIDER_IDS).toContain(id);
    }
  });

  it("rejects duplicate registration", () => {
    const once = fakeProvider("fixture-dup");
    registerProvider(once);
    expect(() => registerProvider(fakeProvider("fixture-dup"))).toThrow(/already registered/);
    expect(providerForId("fixture-dup")).toBe(once);
  });

  it("throws on unregistered ids and reports them as unregistered", () => {
    expect(() => providerForId("fixture-missing")).toThrow(/unknown provider/);
    expect(isRegisteredProviderId("fixture-missing")).toBe(false);
    expect(hasProviderKey("fixture-missing")).toBe(false);
  });

  it("prefers a provider's own hasKey over the builtin env checks", () => {
    registerProvider(fakeProvider("fixture-keyed", () => true));
    expect(hasProviderKey("fixture-keyed")).toBe(true);
    registerProvider(fakeProvider("fixture-keyless", () => false));
    expect(hasProviderKey("fixture-keyless")).toBe(false);
  });

  it("keeps builtin key semantics for providers without hasKey", () => {
    expect(hasProviderKey("mock")).toBe(true);
    // 即梦是占位实现，永远不该被自动路由选中。
    expect(hasProviderKey("jimeng")).toBe(false);
  });
});
