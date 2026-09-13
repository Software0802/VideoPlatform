import { afterEach, describe, expect, it, vi } from "vitest";
import {
  creditsFor,
  isYmanModel,
  modelFor,
  normalizeYmanDuration,
  resolveModel,
  ymanCapabilities,
  ymanCatalog,
  ymanVideoRatios,
  YMAN_MODELS,
} from "./catalog";

// YMAN_MODELS 的键是 `/v1/models` 的展示名（发给上游的那一串），2026-09-06 coder 实测后从早期
// 的内部名（如 `minimax_h3_t2v`）改过来——旧内部名现在是 `aliases`，仍然能被
// resolveModel/modelFor/creditsFor/normalizeYmanDuration 认出，只是不再是权威输出。
// 2026-09-13：上游把 `minimax-H3 文字` 下架改名 `minimax-h3`，旧名同样降级为 alias。
const T2V_DISPLAY = "minimax-h3";
const REF2V_DISPLAY = "minimax-h3-933-图文";
const SEEDANCE_SVIP_DISPLAY = "seedance2.0-900-720p";
const SEEDANCE_DISPLAY = "SD2.0 满血";
const SD25_DISPLAY = "sd-2.5-30秒";
const GROK_PREVIEW_DISPLAY = "grok-video-1.5";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("YMAN_MODELS", () => {
  it("registers exactly six catalog models, keyed by their /v1/models display name", () => {
    expect(Object.keys(YMAN_MODELS).sort()).toEqual(
      [T2V_DISPLAY, REF2V_DISPLAY, GROK_PREVIEW_DISPLAY, SEEDANCE_SVIP_DISPLAY, SEEDANCE_DISPLAY, SD25_DISPLAY].sort(),
    );
  });

  it("keeps each model's old internal name reachable only as an alias, not as a table key", () => {
    for (const alias of ["minimax-H3 文字", "minimax_h3_t2v", "minimax_h3_ref2v", "seedance2.0", "sd2.5"]) {
      expect(Object.keys(YMAN_MODELS)).not.toContain(alias);
    }
  });
});

describe("resolveModel", () => {
  it("resolves a legacy internal alias to the current /v1/models display name", () => {
    expect(resolveModel("minimax_h3_t2v")).toBe(T2V_DISPLAY);
    expect(resolveModel("minimax-H3 文字")).toBe(T2V_DISPLAY);
    expect(resolveModel("seedance2.0")).toBe(SEEDANCE_DISPLAY);
    expect(resolveModel("sd2.5")).toBe(SD25_DISPLAY);
  });

  it("resolves a display name to itself", () => {
    expect(resolveModel(T2V_DISPLAY)).toBe(T2V_DISPLAY);
  });

  it("passes an unrecognized name through unchanged (trimmed) rather than rejecting it", () => {
    expect(resolveModel("  totally-unknown-model  ")).toBe("totally-unknown-model");
  });
});

describe("modelFor", () => {
  it("picks the t2v model for text_to_video and the ref2v model for image/reference to video", () => {
    expect(modelFor("text_to_video")).toBe(T2V_DISPLAY);
    expect(modelFor("image_to_video")).toBe(REF2V_DISPLAY);
    expect(modelFor("reference_to_video")).toBe(REF2V_DISPLAY);
  });

  it("honours YMAN_T2V_MODEL / YMAN_I2V_MODEL overrides, passing an unrecognized override straight through", () => {
    vi.stubEnv("YMAN_T2V_MODEL", "custom-t2v");
    vi.stubEnv("YMAN_I2V_MODEL", "custom-ref2v");
    expect(modelFor("text_to_video")).toBe("custom-t2v");
    expect(modelFor("image_to_video")).toBe("custom-ref2v");
  });

  it("resolves an override that names a legacy alias to the current display name", () => {
    vi.stubEnv("YMAN_T2V_MODEL", "seedance2.0"); // an old-style alias, not the current key
    expect(modelFor("text_to_video")).toBe(SEEDANCE_DISPLAY);
  });
});

describe("ymanVideoRatios", () => {
  it("is the union of the default t2v and i2v/r2v models' ratios (16:9 / 9:16 only by default)", () => {
    expect(ymanVideoRatios().sort()).toEqual(["16:9", "9:16"].sort());
  });

  it("picks up 1:1 once a model that lists it is put in the t2v/i2v slot", () => {
    // SD2.0 满血 is the only built-in model with 1:1 in its ratios.
    vi.stubEnv("YMAN_T2V_MODEL", SEEDANCE_DISPLAY);
    expect(ymanVideoRatios().sort()).toEqual(["1:1", "16:9", "9:16"].sort());
  });
});

describe("normalizeYmanDuration", () => {
  it("buckets minimax_h3_t2v up its 5/10/15 ladder, clamping above the top tier (4->5, 6/8->10, 12->15, 20->15)", () => {
    expect(normalizeYmanDuration("minimax_h3_t2v", 4)).toBe(5);
    expect(normalizeYmanDuration("minimax_h3_t2v", 6)).toBe(10);
    expect(normalizeYmanDuration("minimax_h3_t2v", 8)).toBe(10);
    expect(normalizeYmanDuration("minimax_h3_t2v", 12)).toBe(15);
    expect(normalizeYmanDuration("minimax_h3_t2v", 20)).toBe(15);
  });

  it("keeps an exact tier unchanged", () => {
    expect(normalizeYmanDuration("minimax_h3_t2v", 5)).toBe(5);
    expect(normalizeYmanDuration("minimax_h3_t2v", 10)).toBe(10);
    expect(normalizeYmanDuration("minimax_h3_t2v", 15)).toBe(15);
  });

  it("buckets seedance2.0-svip-900-720p's shorter 10/15 ladder (5 -> 10)", () => {
    expect(normalizeYmanDuration("seedance2.0-svip-900-720p", 5)).toBe(10);
  });

  it("always books sd2.5 at its single 30s tier, whatever the requested seconds", () => {
    for (const sec of [1, 15, 29, 30, 31, 999]) {
      expect(normalizeYmanDuration("sd2.5", sec)).toBe(30);
    }
  });

  it("falls back to the smallest tier for a missing/non-finite duration", () => {
    expect(normalizeYmanDuration("minimax_h3_t2v", undefined)).toBe(5);
    expect(normalizeYmanDuration("minimax_h3_t2v", Number.NaN)).toBe(5);
    expect(normalizeYmanDuration("sd2.5", undefined)).toBe(30);
  });

  it("still returns a plausible tier for a wholly unrecognized model (falls back to the generic 5/10/15 ladder)", () => {
    expect(normalizeYmanDuration("no-such-model", 7)).toBe(10);
    expect(normalizeYmanDuration("no-such-model", 20)).toBe(15);
  });
});

describe("creditsFor — documented price points", () => {
  it("prices minimax_h3_t2v at 50 / 100 / 150 credits for 5 / 10 / 15s at 720p", () => {
    expect(creditsFor("minimax_h3_t2v", 5, "720p")).toBe(50);
    expect(creditsFor("minimax_h3_t2v", 10, "720p")).toBe(100);
    expect(creditsFor("minimax_h3_t2v", 15, "720p")).toBe(150);
  });

  it("prices grok-imagine-video-1.5-preview at 80 credits for 5s and 100 for 10s", () => {
    expect(creditsFor("grok-imagine-video-1.5-preview", 5, "720p")).toBe(80);
    expect(creditsFor("grok-imagine-video-1.5-preview", 10, "720p")).toBe(100);
  });

  it("prices seedance2.0 at 450 credits for 10s", () => {
    expect(creditsFor("seedance2.0", 10, "720p")).toBe(450);
  });

  it("prices sd2.5 at 200 credits for its single 30s tier", () => {
    expect(creditsFor("sd2.5", 30, "720p")).toBe(200);
  });

  it("books a wholly unrecognized model at YMAN_UNKNOWN_CREDITS (150 by default), never at zero", () => {
    expect(creditsFor("no-such-model", 5, "720p")).toBe(150);
    expect(creditsFor("no-such-model", 5, "720p")).toBeGreaterThan(0);
  });

  it("respects a YMAN_UNKNOWN_CREDITS override for unrecognized models", () => {
    vi.stubEnv("YMAN_UNKNOWN_CREDITS", "77");
    expect(creditsFor("no-such-model", 5, "720p")).toBe(77);
  });

  it("books an unnormalized duration at the model's priciest known duration tier instead of at zero", () => {
    // 7s isn't one of minimax_h3_t2v's billed tiers (5/10/15) — creditsFor doesn't
    // normalize on its own (callers run normalizeYmanDuration first). Half-known
    // (resolution matches, duration doesn't) falls back to the priciest known
    // duration: 10 (resolution) + 140 (max of 40/90/140) = 150.
    expect(creditsFor("minimax_h3_t2v", 7, "720p")).toBe(150);
  });
});

describe("isYmanModel", () => {
  it("recognizes every catalog model and rejects a name from another provider", () => {
    for (const model of Object.keys(YMAN_MODELS)) {
      expect(isYmanModel(model)).toBe(true);
    }
    expect(isYmanModel("gpt-image-1")).toBe(false);
    expect(isYmanModel("kling-2.6")).toBe(false);
  });
});

describe("YMAN_MODEL_CATALOG override", () => {
  it("merges a partial override onto the built-in spec, keeping fields it didn't mention", () => {
    vi.stubEnv("YMAN_MODEL_CATALOG", JSON.stringify({ "sd2.5": { credits: { duration: { "30": 999 } } } }));
    // resolution credit (10) untouched, duration credit replaced (190 -> 999): 10 + 999 = 1009.
    expect(creditsFor("sd2.5", 30, "720p")).toBe(1009);
    // Capabilities besides credits are untouched by a credits-only override.
    expect(ymanCapabilities("sd2.5").durations).toEqual([30]);
  });

  it("can register a brand new model that isn't in the built-in table at all", () => {
    vi.stubEnv(
      "YMAN_MODEL_CATALOG",
      JSON.stringify({
        "brand-new-model": {
          durations: [8],
          resolutions: ["720p"],
          ratios: ["16:9"],
          maxReferenceImages: 0,
          credits: { resolution: { "720p": 5 }, duration: { "8": 20 } },
        },
      }),
    );
    expect(isYmanModel("brand-new-model")).toBe(true);
    expect(creditsFor("brand-new-model", 8, "720p")).toBe(25);
    expect(normalizeYmanDuration("brand-new-model", 3)).toBe(8);
    // Built-in models are untouched by an additive override.
    expect(creditsFor("minimax_h3_t2v", 5, "720p")).toBe(50);
  });

  it("falls back to the built-in table and warns once when the JSON is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("YMAN_MODEL_CATALOG", '{"sd2.5":{'); // truncated JSON
    expect(ymanCatalog()).toEqual(YMAN_MODELS);
    expect(creditsFor("sd2.5", 30, "720p")).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("YMAN_MODEL_CATALOG");
  });

  it("falls back to the built-in table and warns when the JSON parses but isn't an object", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const raw of ["[]", '"nope"', "42"]) {
      vi.stubEnv("YMAN_MODEL_CATALOG", raw);
      expect(ymanCatalog()).toEqual(YMAN_MODELS);
    }
    expect(warn).toHaveBeenCalled();
  });
});
