import { afterEach, describe, expect, it } from "vitest";
import type { ProviderGenerateRequest } from "./types";
import { currentProviderId, needsSourceFileUpload, providerForId, selectProvider } from "./router";

const ENV_KEYS = ["LUMEN_FORCE_MOCK", "XAI_API_KEY", "SUB2API_API_KEY", "OPENAI_API_KEY"] as const;
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
