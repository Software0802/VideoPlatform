import { describe, expect, it } from "vitest";
import {
  makeRelayCatalog,
  mergeModelSpecs,
  mergeModelTables,
  relayModelDisplayName,
  UNKNOWN_RELAY_MODEL,
  type RelayModelSpec,
} from "./catalog";

/**
 * 目录「快照 ∪ 配置」的深合并（方案 §3.1）：配置里只写 `price` 的条目不能把快照的
 * ratios / resolutions 丢掉——浅合并会整对象替换，之前 assemble.ts 的两处
 * `{...snapshot, ...cfg.catalog.models}` 就是这个 bug。
 *
 * `spec()` 不补默认值：zod 解析出的配置条目本来就是「缺什么省什么」的部分对象，
 * 合并函数必须容忍缺字段。
 */
function spec(over: Partial<RelayModelSpec>): RelayModelSpec {
  return over as RelayModelSpec;
}

describe("mergeModelSpecs", () => {
  const snapshot = spec({
    kind: "video",
    upstreamName: "Seedance 上游名",
    durations: [5, 10],
    resolutions: ["720p", "1080p"],
    ratios: ["16:9", "9:16"],
    maxReferenceImages: 9,
    credits: { resolution: { "720p": 10 }, duration: { "5": 40, "10": 90 } },
  });

  it("配置只写 price：快照的档位字段全部保留，price 按子对象并入", () => {
    const merged = mergeModelSpecs(snapshot, spec({ price: { video: { "5": 6 } } }));
    expect(merged.ratios).toEqual(["16:9", "9:16"]);
    expect(merged.resolutions).toEqual(["720p", "1080p"]);
    expect(merged.durations).toEqual([5, 10]);
    expect(merged.maxReferenceImages).toBe(9);
    expect(merged.kind).toBe("video");
    expect(merged.upstreamName).toBe("Seedance 上游名");
    expect(merged.price).toEqual({ video: { "5": 6 } });
  });

  it("配置字段 undefined 不覆盖快照；给了的值覆盖", () => {
    const merged = mergeModelSpecs(
      snapshot,
      spec({ name: "精选名", upstreamName: undefined, durations: [10] }),
    );
    expect(merged.name).toBe("精选名");
    expect(merged.upstreamName).toBe("Seedance 上游名");
    expect(merged.durations).toEqual([10]);
  });

  it("credits 按 resolution / duration / flat 子对象合并，而不是整对象替换", () => {
    const merged = mergeModelSpecs(
      snapshot,
      spec({
        credits: { resolution: { "1080p": 20 }, duration: { "15": 120 }, flat: 55 },
      }),
    );
    expect(merged.credits.resolution).toEqual({ "720p": 10, "1080p": 20 });
    expect(merged.credits.duration).toEqual({ "5": 40, "10": 90, "15": 120 });
    expect(merged.credits.flat).toBe(55);
    // 配置没给 flat 时保留快照的。
    const keepFlat = mergeModelSpecs(
      spec({ credits: { resolution: {}, duration: {}, flat: 30 } }),
      spec({ credits: { resolution: {}, duration: { "5": 1 } } }),
    );
    expect(keepFlat.credits.flat).toBe(30);
  });

  it("price 的 video / image 两组各自深合并", () => {
    const merged = mergeModelSpecs(
      spec({ price: { video: { "5": 2, "10": 4 }, image: { "1k": 0.5 } } }),
      spec({ price: { video: { "5": 6 } } }),
    );
    expect(merged.price).toEqual({
      video: { "5": 6, "10": 4 },
      image: { "1k": 0.5 },
    });
  });

  it("单边缺失时返回另一边；都没有给通用兜底", () => {
    expect(mergeModelSpecs(snapshot, undefined)).toBe(snapshot);
    const only = spec({ name: "x" });
    expect(mergeModelSpecs(undefined, only)).toBe(only);
    expect(mergeModelSpecs(undefined, undefined)).toBe(UNKNOWN_RELAY_MODEL);
  });
});

describe("mergeModelTables", () => {
  it("同名模型深合并，各自独有的键都保留", () => {
    const merged = mergeModelTables(
      { "snap-only": spec({ kind: "image" }), shared: spec({ ratios: ["1:1"] }) },
      { shared: spec({ hidden: true }), "cfg-only": spec({ name: "配置新增" }) },
    );
    expect(Object.keys(merged).sort()).toEqual(["cfg-only", "shared", "snap-only"]);
    expect(merged["shared"].ratios).toEqual(["1:1"]);
    expect(merged["shared"].hidden).toBe(true);
    expect(merged["cfg-only"].name).toBe("配置新增");
  });
});

describe("makeRelayCatalog.specFor 兜底", () => {
  it("配置-only 条目只写 hidden/price：能力字段补齐，normalizeDuration/creditsFor 不抛", () => {
    const catalog = makeRelayCatalog({
      table: () => ({
        "cfg-only": spec({ hidden: true, price: { video: { "5": 3, "10": 6 } } }),
      }),
      unknownCredits: () => 99,
      configuredModel: () => "cfg-only",
    });
    const specOut = catalog.specFor("cfg-only");
    expect(specOut.durations).toEqual(UNKNOWN_RELAY_MODEL.durations);
    expect(specOut.resolutions).toEqual(UNKNOWN_RELAY_MODEL.resolutions);
    expect(specOut.ratios).toEqual(UNKNOWN_RELAY_MODEL.ratios);
    expect(specOut.maxReferenceImages).toBe(UNKNOWN_RELAY_MODEL.maxReferenceImages);
    expect(specOut.credits).toEqual({ resolution: {}, duration: {}, flat: undefined });
    expect(specOut.hidden).toBe(true);
    expect(specOut.price).toEqual({ video: { "5": 3, "10": 6 } });
    expect(() => catalog.normalizeDuration("cfg-only", 7)).not.toThrow();
    expect(catalog.normalizeDuration("cfg-only", 7)).toBe(10);
    expect(() => catalog.videoRatios()).not.toThrow();
    expect(() => catalog.videoResolutions()).not.toThrow();
    // 表里有这个键但 credits 全空 → flat 缺省 → unknownCredits。
    expect(catalog.creditsFor("cfg-only", 5, "720p")).toBe(99);
    // credits 只给了 flat 时照 flat 计。
    const flatCatalog = makeRelayCatalog({
      table: () => ({ m: spec({ credits: { flat: 12 } as RelayModelSpec["credits"] }) }),
      unknownCredits: () => 99,
      configuredModel: () => undefined,
    });
    expect(flatCatalog.creditsFor("m", 5, "720p")).toBe(12);
  });
});

describe("relayModelDisplayName", () => {
  it("解析顺序：配置 name → 快照 upstreamName → 目录键", () => {
    expect(
      relayModelDisplayName("m-id", spec({ name: "  ", upstreamName: "上游名" })),
    ).toBe("上游名");
    expect(relayModelDisplayName("m-id", spec({ upstreamName: "上游名" }))).toBe("上游名");
    expect(relayModelDisplayName("m-id", spec({ name: "配置名", upstreamName: "上游名" }))).toBe(
      "配置名",
    );
    expect(relayModelDisplayName("m-id", spec({}))).toBe("m-id");
  });
});
