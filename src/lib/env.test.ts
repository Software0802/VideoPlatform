import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUB2API_BASE,
  grokApiKey,
  grokUpstreamKind,
  isMockMode,
  normalizeXaiBase,
  OFFICIAL_XAI_BASE,
  upstreamRetryBaseMs,
  upstreamTimeoutMs,
  xaiBase,
} from "./env";

const KEYS = [
  "XAI_API_KEY",
  "SUB2API_API_KEY",
  "XAI_BASE_URL",
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
