import { afterEach, describe, expect, it } from "vitest";
import type { ProviderGenerateRequest } from "./types";
import { currentProviderId, needsSourceFileUpload, providerForId, selectProvider } from "./router";

const ENV_KEYS = [
  "LUMEN_FORCE_MOCK",
  "XAI_API_KEY",
  "SUB2API_API_KEY",
  "OPENAI_API_KEY",
  "KLING_API_KEY",
  "VIDEO_PROVIDER",
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
