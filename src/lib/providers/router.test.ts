import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError, type ProviderGenerateRequest } from "./types";
import {
  currentProviderId,
  effectiveVideoProviderOrder,
  needsSourceFileUpload,
  providerForId,
  selectProvider,
  uiProviderId,
  videoAspectRatios,
  videoDurationsFor,
} from "./router";

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

  it("routes a 30/45/60s harness request to Kling when it leads the order — Kling declares both t2v and i2v", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    for (const durationSec of [30, 45, 60]) {
      expect(selectProvider(reqDuration("text_to_video", durationSec)).id).toBe("kling");
    }
    expect(currentProviderId("text_to_video", { harness: true })).toBe("kling");
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

  it("ignores unregistered ids in VIDEO_PROVIDER_ORDER and warns only once per id", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "fixture-unregistered,kling";
    process.env.KLING_API_KEY = "kling-test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(effectiveVideoProviderOrder()).toEqual(["kling"]);
      // 再调一次（以及路由再走一遍）不得重复 warn。
      expect(effectiveVideoProviderOrder()).toEqual(["kling"]);
      expect(currentProviderId("text_to_video")).toBe("kling");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
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

  it("routes a 30s harness request to YMan when it leads the order — YMan declares both t2v and i2v", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(reqDuration("text_to_video", 30)).id).toBe("yman");
    expect(currentProviderId("text_to_video", { harness: true })).toBe("yman");
  });

  it("walks ORDER past providers that do not declare the harness pair (i2v + t2v)", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    // openai 是图片 provider（只声明 text_to_image）：长片必须从它身边走过去。
    process.env.VIDEO_PROVIDER_ORDER = "openai,kling";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(reqDuration("text_to_video", 30)).id).toBe("kling");
    expect(currentProviderId("text_to_video", { harness: true })).toBe("kling");
  });

  it("400s a harness request when no ORDER provider can serve the requested ratio", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    delete process.env.XAI_API_KEY;
    const request = reqDuration("text_to_video", 30);
    request.aspectRatio = "4:3";
    expect(() => selectProvider(request)).toThrow(ProviderHttpError);
    try {
      currentProviderId("text_to_video", { harness: true, aspectRatio: "4:3" });
      throw new Error("expected currentProviderId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
    }
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

/**
 * env.ts: `videoProviderOrder()`'s bare default (no `VIDEO_PROVIDER`, no
 * `VIDEO_PROVIDER_ORDER`) changed from `kling,grok` to `grok`-only — the legacy
 * `VIDEO_PROVIDER=kling` switch is the only way to opt Kling back in. A stray
 * `KLING_API_KEY` sitting in the environment must not be enough on its own.
 */
describe("selectProvider / currentProviderId — bare default order is Grok-only", () => {
  it("ignores a configured Kling key on the bare default (no VIDEO_PROVIDER, no ORDER)", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.VIDEO_PROVIDER;
    delete process.env.VIDEO_PROVIDER_ORDER;
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    expect(selectProvider(req("text_to_video")).id).toBe("grok");
    expect(currentProviderId("text_to_video")).toBe("grok");
  });
});

/**
 * Exhaustion-aware routing (`@/lib/providers/exhaustion`): once `markExhausted` records a
 * provider+kind as out of credit, `pickVideoProvider` / `pickImageProvider` / the Grok
 * fallback must all skip it until the TTL elapses. These tests write to
 * `<DATA_DIR>/provider-state.json`, so each one gets its own temporary DATA_DIR — this must
 * never touch the repo's real `data/` directory.
 */
describe("selectProvider / currentProviderId — exhaustion-aware routing", () => {
  let dataRoot = "";
  let markExhausted: typeof import("@/lib/providers/exhaustion").markExhausted;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-router-exhaustion-"));
    process.env.DATA_DIR = dataRoot;
    ({ markExhausted } = await import("@/lib/providers/exhaustion"));
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("skips an exhausted leader and falls through to the next entry in VIDEO_PROVIDER_ORDER", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.YMAN_API_KEY = "yman-test-key";
    await markExhausted("kling", "video", "积分不足");

    expect(selectProvider(req("text_to_video")).id).toBe("yman");
    expect(currentProviderId("text_to_video")).toBe("yman");
  });

  it("skips an exhausted image provider and falls through IMAGE_PROVIDER_ORDER", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.XAI_API_KEY = "xai-live";
    await markExhausted("openai", "image", "余额不足");

    expect(selectProvider(req("text_to_image")).id).toBe("grok");
    expect(currentProviderId("text_to_image")).toBe("grok");
  });

  it("throws 503 no_provider_available for video once every configured provider, including the Grok fallback, is exhausted", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    await markExhausted("kling", "video", "积分不足");
    await markExhausted("grok", "video", "积分不足"); // the fallback itself must be checked too

    expect(() => selectProvider(req("text_to_video"))).toThrow(ProviderHttpError);
    try {
      currentProviderId("text_to_video");
      throw new Error("expected currentProviderId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 503, code: "no_provider_available" });
    }
  });

  it("throws 503 no_provider_available for text_to_image once OpenAI and its Grok fallback are both exhausted", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.XAI_API_KEY = "xai-live";
    await markExhausted("openai", "image", "余额不足");
    await markExhausted("grok", "image", "余额不足");

    expect(() => selectProvider(req("text_to_image"))).toThrow(ProviderHttpError);
    try {
      currentProviderId("text_to_image");
      throw new Error("expected currentProviderId to throw");
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: "no_provider_available" });
    }
  });

  it("never 503s a fully-mock instance — zero real keys means mock stays the normal outcome even with a stray exhaustion record", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    delete process.env.XAI_API_KEY;
    delete process.env.SUB2API_API_KEY;
    delete process.env.KLING_API_KEY;
    delete process.env.YMAN_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // A leftover record from before every key was removed (e.g. a redeployed instance)
    // must not turn "no key configured" into a 503.
    await markExhausted("kling", "video", "历史记录");

    expect(selectProvider(req("text_to_video")).id).toBe("mock");
    expect(currentProviderId("text_to_video")).toBe("mock");
    expect(selectProvider(req("text_to_image")).id).toBe("mock");
    expect(currentProviderId("text_to_image")).toBe("mock");
  });

  it("uiProviderId never throws even when currentProviderId would 503 — the homepage must still render", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";
    await markExhausted("kling", "video", "积分不足");
    await markExhausted("grok", "video", "积分不足");

    // The submit path must still refuse …
    expect(() => currentProviderId("text_to_video")).toThrow(ProviderHttpError);
    // … but the read-only display path degrades instead of throwing, so `/` and
    // `/api/health` can still render something rather than a 500.
    expect(() => uiProviderId("text_to_video")).not.toThrow();
    expect(uiProviderId("text_to_video")).toBe("kling");
  });

  /**
   * `videoAspectRatios()` unions capabilities only from providers it does not skip.
   * With YMan as the sole (keyed) entry, an exhausted YMan must behave like "no keyed
   * provider at all" — the union is empty, so it must fall back to the full three-ratio
   * chip set rather than silently keeping YMan's now-unreachable 16:9/9:16 pair.
   */
  it("videoAspectRatios drops an exhausted sole provider's ratios and falls back to the full chip set", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";

    // Before exhaustion: YMan's default t2v/i2v models only declare 16:9/9:16 (see
    // yman/catalog.test.ts's ymanVideoRatios tests), so 1:1 is absent.
    expect(videoAspectRatios().sort()).toEqual(["16:9", "9:16"].sort());

    await markExhausted("yman", "video", "积分不足");

    expect(videoAspectRatios().sort()).toEqual(["1:1", "16:9", "9:16"].sort());
  });

  /**
   * Integration check mirroring how `page.tsx` / `/api/health` actually chain these two
   * functions: the duration chip must follow whichever provider `uiProviderId` resolves to,
   * so once the leader is exhausted the chip switches from Kling's [5, 10] to Grok's
   * continuous default ladder rather than staying stuck on the unreachable provider's values.
   */
  it("videoDurationsFor(uiProviderId(...)) follows the provider once the leader becomes exhausted", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,grok";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-live";

    expect(videoDurationsFor(uiProviderId("text_to_video"))).toEqual([5, 10]);

    await markExhausted("kling", "video", "积分不足");

    expect(uiProviderId("text_to_video")).toBe("grok");
    expect(videoDurationsFor(uiProviderId("text_to_video"))).toEqual([4, 6, 8, 10]);
  });
});

/**
 * 契约 A1：「router 能力筛选含分辨率」。`servesResolutionCap` 的方向与画幅一致——只挡
 * 「这家出不了这么高」，480p 的请求交给只有 720p 的一家不受影响（向上归一）。
 * YMan 默认 t2v/i2v 模型只出 720p（见 yman/catalog.test.ts 的 ymanVideoResolutions），
 * 可灵两档都出，是这里唯一现成的「一家不够高、另一家够」的组合。
 */
describe("selectProvider / currentProviderId — resolution-aware routing (契约 A1)", () => {
  function reqRes(
    mode: ProviderGenerateRequest["mode"],
    resolution: ProviderGenerateRequest["resolution"],
  ): ProviderGenerateRequest {
    return { jobId: "job_router", mode, prompt: "p", model: "m", generateAudio: false, resolution };
  }

  it("skips a 720p-only leader for a 1080p request, falling through to a provider that can serve it", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(selectProvider(reqRes("text_to_video", "1080p")).id).toBe("kling");
    expect(currentProviderId("text_to_video", { resolution: "1080p" })).toBe("kling");
  });

  it("still uses YMan for a resolution it does serve (720p), in the same configuration", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(selectProvider(reqRes("text_to_video", "720p")).id).toBe("yman");
    expect(currentProviderId("text_to_video", { resolution: "720p" })).toBe("yman");
  });

  it("throws 400 invalid_argument when YMan is the only configured provider and can't serve 1080p", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    delete process.env.XAI_API_KEY;
    expect(() => selectProvider(reqRes("text_to_video", "1080p"))).toThrow(ProviderHttpError);
    try {
      currentProviderId("text_to_video", { resolution: "1080p" });
      throw new Error("expected currentProviderId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
    }
  });

  it("never lets an unset resolution trip the filter — every video mode still works with none given", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(selectProvider(req("text_to_video")).id).toBe("yman");
    expect(currentProviderId("text_to_video")).toBe("yman");
  });
});

/**
 * 契约 A1：「needsLastFrame 只落 kling」。`capabilities().supportsLastFrameLock` 当前只有
 * 可灵为 true；一个带 `lastImage` 的请求必须只落到它，即便别家排在前面，且**兜底也要
 * 过这一关**——grok 能力最全但同样发不出尾帧。
 */
describe("selectProvider / currentProviderId — needsLastFrame routing (契约 A1)", () => {
  function reqLastFrame(mode: ProviderGenerateRequest["mode"]): ProviderGenerateRequest {
    return {
      jobId: "job_router",
      mode,
      prompt: "p",
      model: "m",
      generateAudio: false,
      lastImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,a" },
    };
  }

  it("routes a lastImage-bearing request to kling even when YMan leads the order", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(selectProvider(reqLastFrame("image_to_video")).id).toBe("kling");
    expect(currentProviderId("image_to_video", { needsLastFrame: true })).toBe("kling");
  });

  it("ignores lastImage-driven routing for a request that doesn't carry one, in the same configuration", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(selectProvider(req("image_to_video")).id).toBe("yman");
  });

  it("throws 400 invalid_argument when no configured provider — including the grok fallback — supports last-frame locking", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    // A real xAI key is present so the fallback path is actually exercised, not skipped
    // for lack of any key at all — grok must still be rejected, since it never declares
    // supportsLastFrameLock.
    process.env.XAI_API_KEY = "xai-live";
    expect(() => selectProvider(reqLastFrame("image_to_video"))).toThrow(ProviderHttpError);
    try {
      currentProviderId("image_to_video", { needsLastFrame: true });
      throw new Error("expected currentProviderId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
    }
  });
});

/**
 * 契约 A1：「新导出 videoResolutions()」，与 videoAspectRatios() 同一套并集逻辑。
 * 用动态 import 而不是加进文件顶部的静态 import——这个符号在任务派发时还不存在，
 * 静态 import 一个不存在的具名导出可能让整份测试文件在收集阶段就跑不起来，
 * 掩盖掉上面这些已经能跑的路由测试。
 */
describe("videoResolutions (契约 A1, 新增导出)", () => {
  async function loadVideoResolutions(): Promise<(() => string[]) | undefined> {
    const mod: Record<string, unknown> = await import("./router");
    return typeof mod.videoResolutions === "function"
      ? (mod.videoResolutions as () => string[])
      : undefined;
  }

  it("is exported as a function from router.ts", async () => {
    const videoResolutions = await loadVideoResolutions();
    expect(typeof videoResolutions).toBe("function");
  });

  it("unions the resolutions of every keyed, non-exhausted video provider", async () => {
    const videoResolutions = await loadVideoResolutions();
    if (!videoResolutions) throw new Error("router.ts 尚未导出 videoResolutions() — 见契约 A1");
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(videoResolutions().sort()).toEqual(["720p", "1080p"].sort());
  });

  it("falls back to the full tier set once no keyed provider declares resolutions", async () => {
    const videoResolutions = await loadVideoResolutions();
    if (!videoResolutions) throw new Error("router.ts 尚未导出 videoResolutions() — 见契约 A1");
    process.env.LUMEN_FORCE_MOCK = "1";
    expect(videoResolutions().sort()).toEqual(["480p", "720p", "1080p"].sort());
  });
});
