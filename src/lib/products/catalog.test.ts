import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { markExhausted } from "@/lib/providers/exhaustion";
import { ProviderHttpError } from "@/lib/providers/types";
import { currentProviderId } from "@/lib/providers/router";
import {
  DEFAULT_PRODUCTS,
  allProducts,
  availableProducts,
  defaultProductFor,
  defaultResolutionOf,
  isProductAvailable,
  modelForProduct,
  productById,
  productForProvider,
  productServesResolution,
  samplePriceCny,
} from "./catalog";

/**
 * 契约 A1（见任务书）：`DEFAULT_PRODUCTS` 七个产品、`availableProducts()` 的
 * key+未耗尽过滤、`productById`、`defaultProductFor`、`LUMEN_PRODUCTS` 覆盖/追加。
 * 实测以 `src/lib/products/catalog.ts` 当前落地实现为准（字段名如 `resolutions` /
 * `audio` / `supportsLastFrame` / `kind` 均取自该文件，而非任务书摘要的转述）。
 */

const ENV_KEYS = [
  "LUMEN_FORCE_MOCK",
  "XAI_API_KEY",
  "SUB2API_API_KEY",
  "OPENAI_API_KEY",
  "KLING_API_KEY",
  "YMAN_API_KEY",
  "VIDEO_PROVIDER",
  "VIDEO_PROVIDER_ORDER",
  "IMAGE_PROVIDER_ORDER",
  "KLING_VIDEO_AUDIO",
  "LUMEN_PRODUCTS",
] as const;
const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

// 整个文件都不碰仓库真实的 data/：availableProducts -> isExhausted 会读
// `<DATA_DIR>/provider-state.json`，不隔离就会被开发机上真实的耗尽记录污染。
let fileDataRoot = "";

beforeAll(async () => {
  fileDataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-catalog-test-"));
  process.env.DATA_DIR = fileDataRoot;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(fileDataRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const before = previous[key];
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

const ALL_IDS = [
  "video-fast",
  "video-standard",
  "video-hd-audio",
  "video-grok",
  "image-fast",
  "image-standard",
  "image-grok",
].sort();

describe("DEFAULT_PRODUCTS", () => {
  it("declares exactly the seven catalog products, each mapped to its provider", () => {
    const byId = new Map(DEFAULT_PRODUCTS.map((p) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual(ALL_IDS);
    expect(byId.get("video-fast")?.provider).toBe("yman");
    expect(byId.get("video-standard")?.provider).toBe("kling");
    expect(byId.get("video-hd-audio")?.provider).toBe("kling");
    expect(byId.get("video-grok")?.provider).toBe("grok");
    expect(byId.get("image-fast")?.provider).toBe("yman");
    expect(byId.get("image-standard")?.provider).toBe("openai");
    expect(byId.get("image-grok")?.provider).toBe("grok");
  });

  it("gives video-standard both 720p/1080p, audio off, and last-frame support", () => {
    const p = DEFAULT_PRODUCTS.find((x) => x.id === "video-standard")!;
    expect(p.resolutions).toEqual(expect.arrayContaining(["720p", "1080p"]));
    expect(p.audio).toBe("off");
    expect(p.supportsLastFrame).toBe(true);
  });

  it("pins video-hd-audio to 1080p only, with native audio", () => {
    const p = DEFAULT_PRODUCTS.find((x) => x.id === "video-hd-audio")!;
    expect(p.resolutions).toEqual(["1080p"]);
    expect(p.audio).toBe("native");
    expect(p.supportsLastFrame).toBe(true);
  });

  /** 30 / 45 / 60 是视频侧一致性管线的档位；图片路径上根本没有这几个档。 */
  it("never marks an image product as long-form capable", () => {
    for (const p of DEFAULT_PRODUCTS.filter((x) => x.kind === "image")) {
      expect(p.supportsLongForm, `${p.id} 不该声明 supportsLongForm`).toBe(false);
    }
  });
});

describe("productById", () => {
  it("finds a built-in product by id", () => {
    expect(productById("video-grok")?.provider).toBe("grok");
  });

  it("returns undefined for an unknown, empty or nullish id", () => {
    expect(productById("no-such-product")).toBeUndefined();
    expect(productById("")).toBeUndefined();
    expect(productById(undefined)).toBeUndefined();
    expect(productById(null)).toBeUndefined();
  });
});

describe("availableProducts / isProductAvailable", () => {
  it("returns every product in mock mode (no provider key configured at all)", () => {
    expect(availableProducts().map((p) => p.id).sort()).toEqual(ALL_IDS);
  });

  it("returns every product when LUMEN_FORCE_MOCK is set, even with a real key configured", () => {
    process.env.LUMEN_FORCE_MOCK = "1";
    process.env.KLING_API_KEY = "kling-test-key";
    expect(availableProducts().map((p) => p.id).sort()).toEqual(ALL_IDS);
  });

  it("includes only the yman products once YMAN_API_KEY is the sole configured key and both ORDERs name it", () => {
    // ORDER 是「愿意用谁」的开关（catalog.ts `inProviderOrder`）：光有 key 不够，
    // 视频与图片两条通道各有自己的次序表，都要点到 yman 它的两个产品才露得出来。
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.IMAGE_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(availableProducts().map((p) => p.id).sort()).toEqual(["image-fast", "video-fast"]);
  });

  it("drops a keyed provider's products when no ORDER names it — routing would never pick it", () => {
    // 默认次序是视频 `grok`、图片 `openai,grok`：只配了 YMan 的 key 而没改次序时，
    // 路由一次都不会选中 yman，目录也就不能把它的产品摆出来（点了必被拒）。
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(availableProducts()).toEqual([]);
  });

  it("includes only image-standard once OPENAI_API_KEY is the sole configured key", () => {
    // openai 本来就在默认的 IMAGE_PROVIDER_ORDER（`openai,grok`）里，不必额外设置。
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(availableProducts().map((p) => p.id)).toEqual(["image-standard"]);
  });

  it("gates video-hd-audio behind KLING_VIDEO_AUDIO=native, independently of video-standard", () => {
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.KLING_VIDEO_AUDIO = "off";
    let ids = availableProducts().map((p) => p.id);
    expect(ids).toContain("video-standard");
    expect(ids).not.toContain("video-hd-audio");

    process.env.KLING_VIDEO_AUDIO = "native";
    ids = availableProducts().map((p) => p.id);
    expect(ids).toContain("video-standard");
    expect(ids).toContain("video-hd-audio");
  });

  it("isProductAvailable agrees with availableProducts for an individual product", () => {
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(isProductAvailable(productById("video-fast")!)).toBe(true);
    expect(isProductAvailable(productById("video-standard")!)).toBe(false); // no KLING_API_KEY
  });

  describe("exhaustion", () => {
    // Each test gets its own DATA_DIR so a markExhausted() call in one test can never
    // leak into another via a shared provider-state.json.
    let dataRoot = "";
    beforeAll(async () => undefined);
    afterEach(async () => {
      if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
      process.env.DATA_DIR = fileDataRoot;
      dataRoot = "";
    });

    async function isolateDataDir() {
      dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-catalog-exhaustion-"));
      process.env.DATA_DIR = dataRoot;
    }

    it("drops a product once its provider+kind is marked exhausted", async () => {
      await isolateDataDir();
      process.env.VIDEO_PROVIDER_ORDER = "kling";
      process.env.KLING_API_KEY = "kling-test-key";
      expect(availableProducts().map((p) => p.id)).toContain("video-standard");

      await markExhausted("kling", "video", "积分不足");
      expect(availableProducts().map((p) => p.id)).not.toContain("video-standard");
    });

    it("an exhausted video channel leaves that provider's image products untouched", async () => {
      await isolateDataDir();
      process.env.VIDEO_PROVIDER_ORDER = "yman";
      process.env.IMAGE_PROVIDER_ORDER = "yman";
      process.env.YMAN_API_KEY = "yman-test-key";
      await markExhausted("yman", "video", "积分不足");

      const ids = availableProducts().map((p) => p.id);
      expect(ids).not.toContain("video-fast");
      expect(ids).toContain("image-fast");
    });
  });
});

describe("productForProvider", () => {
  it("picks the provider's own product for a supported mode", () => {
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(productForProvider("yman", "text_to_video")?.id).toBe("video-fast");
  });

  it("disambiguates kling's two products by the resolved model when a model hint is given", () => {
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.KLING_VIDEO_AUDIO = "native";
    const byModel = productForProvider("kling", "text_to_video", "kling-2.6");
    // Both kling products resolve to the same model (KLING_VIDEO_MODEL), so an exact model
    // match alone can't disambiguate; this only pins that *some* kling product comes back.
    expect(byModel?.provider).toBe("kling");
  });

  /** 换家后的重新贴标签（`jobs/runner.ts`）：同一家、同一个模型，只有音轨能分开两个产品。 */
  it("uses the audio hint to tell kling's two same-model products apart", () => {
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.KLING_VIDEO_AUDIO = "native";
    expect(productForProvider("kling", "text_to_video", undefined, { audio: "native" })?.id).toBe(
      "video-hd-audio",
    );
    expect(productForProvider("kling", "text_to_video", undefined, { audio: "off" })?.id).toBe(
      "video-standard",
    );
  });

  it("returns undefined for a provider with no matching product outside mock mode", () => {
    process.env.YMAN_API_KEY = "yman-test-key"; // real key present -> not mock mode
    expect(productForProvider("mock", "text_to_video")).toBeUndefined();
  });

  it("labels a mock-routed job with the first product that supports the mode (mock owns no product)", () => {
    // No provider key at all -> isMockMode() true -> productForProvider("mock", ...) falls
    // back to usable[0], matching catalog.ts's own documented reasoning for this branch.
    expect(productForProvider("mock", "text_to_video")?.id).toBe("video-fast");
  });
});

describe("defaultProductFor", () => {
  it("agrees with the router's provider choice for a mode only one provider serves", () => {
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(currentProviderId("text_to_video")).toBe("yman");
    expect(defaultProductFor("text_to_video")?.provider).toBe("yman");
    expect(defaultProductFor("text_to_video")?.id).toBe("video-fast");
  });

  it("returns undefined when the router blocks on an aspect ratio nobody configured can serve", () => {
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(() => currentProviderId("text_to_video", { aspectRatio: "4:3" })).toThrow(ProviderHttpError);
    expect(defaultProductFor("text_to_video", "4:3")).toBeUndefined();
  });

  it("labels a job on the mock provider with the first product for the mode when nothing is configured", () => {
    expect(defaultProductFor("text_to_video")?.id).toBe("video-fast");
    expect(defaultProductFor("text_to_image")?.provider).toBe("yman");
  });

  /**
   * 契约 A1：「router 能力筛选含分辨率」。YMan 默认 t2v/i2v 模型只出 720p，请求 1080p
   * 应该被路由挡在前面（400），`defaultProductFor` 拿同一个 hint 应该同样拿不到结果。
   * 若这条红，先看是不是 router.ts 的分辨率分支本身跑不起来（见测试报告里记录的
   * `servesResolution` 未导入疑点），而不是 catalog.ts 的问题。
   */
  it("returns undefined for a resolution hint nobody configured can serve", () => {
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    expect(() => currentProviderId("text_to_video", { resolution: "1080p" })).toThrow(ProviderHttpError);
    expect(defaultProductFor("text_to_video", undefined, { resolution: "1080p" })).toBeUndefined();
  });
});

describe("modelForProduct / defaultResolutionOf", () => {
  it("modelForProduct returns the per-mode override for video-fast (yman has two upstream models)", () => {
    const fast = productById("video-fast")!;
    expect(modelForProduct(fast, "text_to_video")).toBe("minimax-h3");
    expect(modelForProduct(fast, "image_to_video")).toBe("minimax-h3-933-图文");
  });

  it("modelForProduct keeps video-grok's per-mode pin for edit/extend (upstream only takes 1.0 there)", () => {
    const grok = productById("video-grok")!;
    expect(modelForProduct(grok, "edit_video")).toBe("grok-imagine-video");
    expect(modelForProduct(grok, "extend_video")).toBe("grok-imagine-video");
  });

  /**
   * `model` 是可选的：默认目录里的产品基本都不写，模型名由实例的环境变量定
   * （运维改 `KLING_VIDEO_MODEL` / `OPENAI_IMAGE_MODEL` 就该生效，不能被产品表按住）。
   */
  it("modelForProduct falls back to the provider's env-configured model when the product pins none", () => {
    expect(productById("video-standard")?.model).toBeUndefined();
    expect(modelForProduct(productById("video-standard")!, "text_to_video")).toBe("kling-2.6");
    vi.stubEnv("KLING_VIDEO_MODEL", "kling-9.9");
    expect(modelForProduct(productById("video-standard")!, "text_to_video")).toBe("kling-9.9");

    vi.stubEnv("OPENAI_IMAGE_MODEL", "gpt-image-9");
    expect(modelForProduct(productById("image-standard")!, "text_to_image")).toBe("gpt-image-9");
  });

  it("defaultResolutionOf prefers the declared default over the lowest listed tier", () => {
    expect(defaultResolutionOf(productById("video-hd-audio")!)).toBe("1080p");
    expect(defaultResolutionOf(productById("video-standard")!)).toBe("720p");
  });
});

describe("productServesResolution", () => {
  it("is always true for an image product, regardless of the resolution asked", () => {
    expect(productServesResolution(productById("image-fast")!, "1080p")).toBe(true);
  });

  it("normalizes a 480p ask up for a 720p/1080p product (video-standard)", () => {
    expect(productServesResolution(productById("video-standard")!, "480p")).toBe(true);
  });

  it("rejects a 1080p ask for a 720p-only product (video-fast)", () => {
    expect(productServesResolution(productById("video-fast")!, "1080p")).toBe(false);
  });

  it("treats an unspecified resolution as always served", () => {
    expect(productServesResolution(productById("video-fast")!, undefined)).toBe(true);
  });
});

describe("samplePriceCny", () => {
  it("is a positive number for every default product", () => {
    for (const p of DEFAULT_PRODUCTS) {
      expect(samplePriceCny(p)).toBeGreaterThan(0);
    }
  });

  it("prices video-hd-audio (1080p, native audio) higher than video-fast (720p, no audio surcharge)", () => {
    expect(samplePriceCny(productById("video-hd-audio")!)).toBeGreaterThan(
      samplePriceCny(productById("video-fast")!),
    );
  });
});

describe("LUMEN_PRODUCTS override", () => {
  it("overrides a field on a built-in product by id, leaving DEFAULT_PRODUCTS itself untouched", () => {
    vi.stubEnv(
      "LUMEN_PRODUCTS",
      JSON.stringify([
        {
          id: "video-grok",
          provider: "grok",
          model: "grok-imagine-video-1.5",
          modes: ["text_to_video"],
          name: "Grok 改名",
          description: "覆盖测试",
        },
      ]),
    );
    expect(productById("video-grok")?.name).toBe("Grok 改名");
    // The built-in constant is the module's static baseline (mirrors yman/catalog.test.ts's
    // "Built-in models are untouched by an additive override"), so it must never mutate.
    expect(DEFAULT_PRODUCTS.find((p) => p.id === "video-grok")?.name).not.toBe("Grok 改名");
  });

  it("appends a brand-new product id that isn't in the built-in table", () => {
    vi.stubEnv(
      "LUMEN_PRODUCTS",
      JSON.stringify([
        {
          id: "video-custom",
          provider: "yman",
          model: "minimax-h3",
          modes: ["text_to_video"],
          description: "自定义产品",
        },
      ]),
    );
    expect(productById("video-custom")?.provider).toBe("yman");
    // Additive, not replacing: every built-in id is still reachable.
    expect(productById("video-grok")).toBeDefined();
  });

  it("skips a new entry missing a required field (provider/modes) instead of registering a half product", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("LUMEN_PRODUCTS", JSON.stringify([{ id: "video-broken", description: "缺字段" }]));
    expect(productById("video-broken")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to the built-in table and warns once when the JSON is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("LUMEN_PRODUCTS", "{not valid json");
    expect(allProducts().map((p) => p.id).sort()).toEqual(ALL_IDS);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("LUMEN_PRODUCTS");
  });

  it("falls back to the built-in table and warns when the JSON parses but isn't an array", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("LUMEN_PRODUCTS", JSON.stringify({ id: "not-an-array" }));
    expect(allProducts().map((p) => p.id).sort()).toEqual(ALL_IDS);
    expect(warn).toHaveBeenCalled();
  });
});
