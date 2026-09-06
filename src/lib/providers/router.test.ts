import { afterEach, describe, expect, it } from "vitest";
import { ProviderHttpError, type ProviderGenerateRequest } from "./types";
import { currentProviderId, needsSourceFileUpload, providerForId, selectProvider } from "./router";

const ENV_KEYS = [
  "LUMEN_FORCE_MOCK",
  "XAI_API_KEY",
  "SUB2API_API_KEY",
  "OPENAI_API_KEY",
  "KLING_API_KEY",
  "VIDEO_PROVIDER",
  "YMAN_API_KEY",
  "VIDEO_PROVIDER_ORDER",
] as const;
const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const before = previous[key];
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

function req(mode: ProviderGenerateRequest["mode"]): ProviderGenerateRequest {
  return { jobId: "job_router", mode, prompt: "p", model: "m", generateAudio: false };
}

describe("provider routing", () => {
  it("keeps a persisted mock job on the mock provider", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    expect(providerForId("mock").id).toBe("mock");
  });

  it("resolves persisted Grok jobs independently of current mock mode", () => {
    process.env.LUMEN_FORCE_MOCK = "1";
    expect(providerForId("grok").id).toBe("grok");
  });

  it("resolves persisted OpenAI image jobs", () => {
    expect(providerForId("openai").id).toBe("openai");
  });

  it("rejects unknown persisted providers", () => {
    expect(() => providerForId("unknown" as never)).toThrow(/unknown provider/);
  });

  it("uploads source files only for Grok edit and extend jobs", () => {
    expect(needsSourceFileUpload("grok", "edit_video")).toBe(true);
    expect(needsSourceFileUpload("grok", "extend_video")).toBe(true);
    expect(needsSourceFileUpload("mock", "edit_video")).toBe(false);
    expect(needsSourceFileUpload("grok", "text_to_video")).toBe(false);
  });
});

describe("selectProvider / currentProviderId", () => {
  it("forces mock for every mode when LUMEN_FORCE_MOCK is set", () => {
    process.env.LUMEN_FORCE_MOCK = "1";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_image")).id).toBe("mock");
    expect(currentProviderId("text_to_image")).toBe("mock");
    expect(currentProviderId("text_to_video")).toBe("mock");
  });

  it("sends text_to_image to OpenAI when its key is present", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_image")).id).toBe("openai");
    expect(currentProviderId("text_to_image")).toBe("openai");
  });

  it("keeps every video mode on Grok even when an OpenAI key exists", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.XAI_API_KEY = "xai-live";
    for (const mode of ["text_to_video", "image_to_video", "extend_video"] as const) {
      expect(selectProvider(req(mode)).id).toBe("grok");
      expect(currentProviderId(mode)).toBe("grok");
    }
  });

  it("falls back to Grok for images when only an xAI key exists", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.OPENAI_API_KEY;
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_image")).id).toBe("grok");
    expect(currentProviderId("text_to_image")).toBe("grok");
  });

  it("runs video on mock while images run on OpenAI for an image-only instance", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.XAI_API_KEY;
    delete process.env.SUB2API_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(selectProvider(req("text_to_image")).id).toBe("openai");
    expect(selectProvider(req("text_to_video")).id).toBe("mock");
    expect(currentProviderId("text_to_image")).toBe("openai");
    expect(currentProviderId("text_to_video")).toBe("mock");
    expect(currentProviderId()).toBe("mock");
  });

  it("falls back to mock for every mode with no keys at all", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(selectProvider(req("text_to_image")).id).toBe("mock");
    expect(selectProvider()).toBe(selectProvider(req("text_to_video")));
    expect(currentProviderId("text_to_image")).toBe("mock");
  });
});

describe("selectProvider / currentProviderId — Kling routing", () => {
  function reqDuration(mode: ProviderGenerateRequest["mode"], durationSec: number): ProviderGenerateRequest {
    return { jobId: "job_router", mode, prompt: "p", model: "m", generateAudio: false, durationSec };
  }

  it("routes text_to_video and image_to_video to Kling once VIDEO_PROVIDER=kling and a key is configured", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    for (const mode of ["text_to_video", "image_to_video"] as const) {
      expect(selectProvider(req(mode)).id).toBe("kling");
      expect(currentProviderId(mode)).toBe("kling");
    }
  });

  it("keeps a 30/45/60s harness request on Grok even with Kling fully configured", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    for (const durationSec of [30, 45, 60]) {
      expect(selectProvider(reqDuration("text_to_video", durationSec)).id).toBe("grok");
    }
    expect(currentProviderId("text_to_video", { harness: true })).toBe("grok");
  });

  it("falls back to Grok when Kling is switched on but no key is configured", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.KLING_API_KEY;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_video")).id).toBe("grok");
    expect(currentProviderId("text_to_video")).toBe("grok");
  });

  it("stays on Grok when the switch is off even though a Kling key exists", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "grok";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_video")).id).toBe("grok");
    expect(currentProviderId("text_to_video")).toBe("grok");
  });

  it("falls back to Grok on an unrecognized VIDEO_PROVIDER value", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "bogus";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_video")).id).toBe("grok");
    expect(currentProviderId("text_to_video")).toBe("grok");
  });

  it("never sends text_to_image to Kling — it stays on the OpenAI/Grok/mock ladder", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_image")).id).toBe("openai");
    expect(currentProviderId("text_to_image")).toBe("openai");

    delete process.env.OPENAI_API_KEY;
    expect(selectProvider(req("text_to_image")).id).toBe("grok");
  });

  it("keeps reference_to_video, edit_video and extend_video on Grok — Kling cannot serve them", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    for (const mode of ["reference_to_video", "edit_video", "extend_video"] as const) {
      expect(selectProvider(req(mode)).id).toBe("grok");
      expect(currentProviderId(mode)).toBe("grok");
    }
  });

  it("still forces mock for every mode when LUMEN_FORCE_MOCK is set, even with Kling configured", () => {
    process.env.LUMEN_FORCE_MOCK = "1";
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(selectProvider(req("text_to_video")).id).toBe("mock");
    expect(currentProviderId("text_to_video")).toBe("mock");
  });

  it("resolves a persisted Kling job back to the Kling provider", () => {
    expect(providerForId("kling").id).toBe("kling");
  });
});

/**
 * VIDEO_PROVIDER_ORDER (方案 §3.4「功能先于供应商」): the router walks the order and takes
 * the first provider that both has a key and declares the requested mode in its own
 * capabilities() — so a provider ahead in the list that can't serve this mode is skipped
 * rather than winning by position alone.
 */
describe("selectProvider / currentProviderId — YMan routing (VIDEO_PROVIDER_ORDER)", () => {
  function reqDuration(mode: ProviderGenerateRequest["mode"], durationSec: number): ProviderGenerateRequest {
    return { jobId: "job_router", mode, prompt: "p", model: "m", generateAudio: false, durationSec };
  }

  it("prefers YMan over Kling for t2v/i2v/r2v when it leads VIDEO_PROVIDER_ORDER and both keys exist", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    for (const mode of ["text_to_video", "image_to_video", "reference_to_video"] as const) {
      expect(selectProvider(req(mode)).id).toBe("yman");
      expect(currentProviderId(mode)).toBe("yman");
    }
  });

  it("still sends edit_video/extend_video to Grok — neither YMan nor Kling declare those modes", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    for (const mode of ["edit_video", "extend_video"] as const) {
      expect(selectProvider(req(mode)).id).toBe("grok");
      expect(currentProviderId(mode)).toBe("grok");
    }
  });

  it("keeps a 30s harness request on Grok even with YMan leading the order and fully configured", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(reqDuration("text_to_video", 30)).id).toBe("grok");
    expect(currentProviderId("text_to_video", { harness: true })).toBe("grok");
  });

  it("keeps Kling when it leads the order for a mode both providers declare", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    for (const mode of ["text_to_video", "image_to_video"] as const) {
      expect(selectProvider(req(mode)).id).toBe("kling");
      expect(currentProviderId(mode)).toBe("kling");
    }
  });

  it("skips Kling for reference_to_video even though it leads the order and has a key — it doesn't declare that mode", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(selectProvider(req("reference_to_video")).id).toBe("yman");
    expect(currentProviderId("reference_to_video")).toBe("yman");
  });

  it("falls through to YMan when Kling leads the order but has no key configured", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    delete process.env.KLING_API_KEY;
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(selectProvider(req("text_to_video")).id).toBe("yman");
    expect(currentProviderId("text_to_video")).toBe("yman");
  });

  it("keeps routing text_to_image through the OpenAI/Grok/mock ladder, untouched by VIDEO_PROVIDER_ORDER", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.XAI_API_KEY = "xai-live";
    delete process.env.OPENAI_API_KEY;
    expect(selectProvider(req("text_to_image")).id).toBe("grok");
    expect(currentProviderId("text_to_image")).toBe("grok");
  });

  it("honours the legacy VIDEO_PROVIDER=kling switch when VIDEO_PROVIDER_ORDER is unset, ignoring a stray YMan key", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.VIDEO_PROVIDER_ORDER;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.YMAN_API_KEY = "yman-test-key"; // must not be picked up without an explicit ORDER
    expect(selectProvider(req("text_to_video")).id).toBe("kling");
    expect(currentProviderId("text_to_video")).toBe("kling");
  });

  it("never routes to YMan on the bare default order (kling,grok) — a stray key alone is not an opt-in", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.VIDEO_PROVIDER;
    delete process.env.KLING_API_KEY;
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_video")).id).toBe("grok");
    expect(currentProviderId("text_to_video")).toBe("grok");
  });

  it("resolves a persisted YMan job back to the YMan provider", () => {
    expect(providerForId("yman").id).toBe("yman");
  });
});

/**
 * types.ts: capabilities().aspectRatios "路由拿它当硬条件：一个不声明 1:1 的 provider
 * 不会被派去做 1:1 的任务，而不是让它把画幅悄悄换成自己的第一档——用户选的画幅是需求，
 * 不是建议。" YMan's default t2v/i2v models only declare 16:9/9:16 (see
 * yman/catalog.test.ts's ymanVideoRatios tests), so this is the first real provider pair
 * where the ratio filter actually has something to bite on.
 */
describe("selectProvider / currentProviderId — ratio-aware routing", () => {
  function reqRatio(mode: ProviderGenerateRequest["mode"], aspectRatio: ProviderGenerateRequest["aspectRatio"]): ProviderGenerateRequest {
    return { jobId: "job_router", mode, prompt: "p", model: "m", generateAudio: false, aspectRatio };
  }

  it("reroutes to Grok when YMan is first in the order but doesn't declare the requested ratio", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,grok";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(reqRatio("text_to_video", "4:3")).id).toBe("grok");
    expect(currentProviderId("text_to_video", { aspectRatio: "4:3" })).toBe("grok");
  });

  it("still uses YMan for a ratio it does declare (16:9), even in the same configuration", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,grok";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(reqRatio("text_to_video", "16:9")).id).toBe("yman");
    expect(currentProviderId("text_to_video", { aspectRatio: "16:9" })).toBe("yman");
  });

  it("throws 400 invalid_argument when YMan is the only configured provider and can't serve the ratio", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    delete process.env.XAI_API_KEY;
    expect(() => selectProvider(reqRatio("text_to_video", "4:3"))).toThrow(ProviderHttpError);
    expect(() => currentProviderId("text_to_video", { aspectRatio: "4:3" })).toThrow(ProviderHttpError);
    try {
      currentProviderId("text_to_video", { aspectRatio: "4:3" });
      throw new Error("expected currentProviderId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
    }
  });

  it("never lets an unset aspectRatio trip the ratio filter — every video mode still works with none given", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(selectProvider(req("text_to_video")).id).toBe("yman");
    expect(currentProviderId("text_to_video")).toBe("yman");
  });
});
