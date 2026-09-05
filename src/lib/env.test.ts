import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_SUB2API_BASE,
  grokApiKey,
  grokUpstreamKind,
  hasOpenaiKey,
  hasXaiKey,
  isMockMode,
  normalizeXaiBase,
  OFFICIAL_OPENAI_BASE,
  OFFICIAL_XAI_BASE,
  openaiApiKey,
  openaiBase,
  openaiImageFlexibleSizes,
  openaiImageModel,
  openaiImagePriceTableRaw,
  openaiImageQuality,
  upstreamRetryBaseMs,
  upstreamTimeoutMs,
  xaiBase,
} from "./env";

const KEYS = [
  "XAI_API_KEY",
  "SUB2API_API_KEY",
  "XAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_IMAGE_FLEXIBLE_SIZES",
  "OPENAI_IMAGE_QUALITY",
  "OPENAI_IMAGE_PRICE_TABLE",
  "LUMEN_FORCE_MOCK",
  "UPSTREAM_TIMEOUT_MS",
  "UPSTREAM_RETRY_BASE_MS",
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("normalizeXaiBase", () => {
  it("appends /v1 and strips trailing slash", () => {
    expect(normalizeXaiBase("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeXaiBase("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeXaiBase("https://api.x.ai/v1")).toBe("https://api.x.ai/v1");
  });
});

describe("upstream selection", () => {
  it("defaults to official xAI with no keys", () => {
    expect(xaiBase()).toBe(OFFICIAL_XAI_BASE);
    expect(grokApiKey()).toBeUndefined();
    expect(isMockMode()).toBe(true);
  });

  it("uses Sub2API key and local default base", () => {
    process.env.SUB2API_API_KEY = "sk-test";
    expect(grokApiKey()).toBe("sk-test");
    expect(xaiBase()).toBe(DEFAULT_SUB2API_BASE);
    expect(grokUpstreamKind()).toBe("sub2api");
    expect(isMockMode()).toBe(false);
  });

  it("prefers official key over Sub2API", () => {
    process.env.XAI_API_KEY = "xai-live";
    process.env.SUB2API_API_KEY = "sk-test";
    expect(grokApiKey()).toBe("xai-live");
    expect(xaiBase()).toBe(OFFICIAL_XAI_BASE);
    expect(grokUpstreamKind()).toBe("xai");
  });

  it("honors explicit XAI_BASE_URL for a remote Sub2API", () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "https://gw.example.com";
    expect(xaiBase()).toBe("https://gw.example.com/v1");
    expect(grokUpstreamKind()).toBe("sub2api");
  });
});

describe("OpenAI image upstream", () => {
  it("defaults to the official base and gpt-image-1 with no key", () => {
    expect(openaiApiKey()).toBeUndefined();
    expect(hasOpenaiKey()).toBe(false);
    expect(openaiBase()).toBe(OFFICIAL_OPENAI_BASE);
    expect(openaiImageModel()).toBe(DEFAULT_OPENAI_IMAGE_MODEL);
  });

  it("normalizes an explicit base and honours a model override", () => {
    process.env.OPENAI_BASE_URL = "https://gw.example.com/";
    process.env.OPENAI_IMAGE_MODEL = " gpt-image-1-mini ";
    expect(openaiBase()).toBe("https://gw.example.com/v1");
    expect(openaiImageModel()).toBe("gpt-image-1-mini");

    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1/";
    expect(openaiBase()).toBe(OFFICIAL_OPENAI_BASE);
  });

  // 语义变更（OpenAI 生图接入）：mock 模式 = 一把上游 key 都没有。只配 OpenAI key 的实例
  // 必须脱离 mock，否则新 provider 永远选不中。
  it("leaves mock mode when only an OpenAI key is present", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(hasXaiKey()).toBe(false);
    expect(hasOpenaiKey()).toBe(true);
    expect(isMockMode()).toBe(false);
  });

  it("still forces mock when LUMEN_FORCE_MOCK is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.LUMEN_FORCE_MOCK = "1";
    expect(isMockMode()).toBe(true);
  });

  it("stays in mock mode when neither upstream has a key", () => {
    expect(isMockMode()).toBe(true);
  });

  it("keeps flexible sizes off unless explicitly enabled", () => {
    expect(openaiImageFlexibleSizes()).toBe(false);
    for (const value of ["0", "false", "yes", "", " "]) {
      process.env.OPENAI_IMAGE_FLEXIBLE_SIZES = value;
      expect(openaiImageFlexibleSizes()).toBe(false);
    }
    for (const value of ["1", "true", " true "]) {
      process.env.OPENAI_IMAGE_FLEXIBLE_SIZES = value;
      expect(openaiImageFlexibleSizes()).toBe(true);
    }
  });

  it("defaults the image quality to high and rejects anything off-menu", () => {
    expect(openaiImageQuality()).toBe("high");
    for (const value of ["low", "medium", "high", "auto"]) {
      process.env.OPENAI_IMAGE_QUALITY = value;
      expect(openaiImageQuality()).toBe(value);
    }
    process.env.OPENAI_IMAGE_QUALITY = " Medium ";
    expect(openaiImageQuality()).toBe("medium");
    for (const value of ["ultra", "hd", "", "2", "null"]) {
      process.env.OPENAI_IMAGE_QUALITY = value;
      expect(openaiImageQuality()).toBe("high");
    }
  });

  it("hands the price table through verbatim (parsing lives in cost.ts)", () => {
    expect(openaiImagePriceTableRaw()).toBeUndefined();
    process.env.OPENAI_IMAGE_PRICE_TABLE = "   ";
    expect(openaiImagePriceTableRaw()).toBeUndefined();
    process.env.OPENAI_IMAGE_PRICE_TABLE = ' {"low":{"1K":0.08}} ';
    expect(openaiImagePriceTableRaw()).toBe('{"low":{"1K":0.08}}');
  });
});

describe("upstream request limits", () => {
  it("uses safe defaults and clamps invalid extremes", () => {
    expect(upstreamTimeoutMs()).toBe(30_000);
    expect(upstreamRetryBaseMs()).toBe(250);

    process.env.UPSTREAM_TIMEOUT_MS = "999999999";
    process.env.UPSTREAM_RETRY_BASE_MS = "-1";
    expect(upstreamTimeoutMs()).toBe(300_000);
    expect(upstreamRetryBaseMs()).toBe(250);
  });
});
