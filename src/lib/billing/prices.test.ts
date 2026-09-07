import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRICE_TABLE, formatCny, priceCny, priceTable, type PriceTable } from "./prices";

/**
 * 售价表（方案 §3.2）：视频 ≤5s/更长两档、1080p 倍率、出声加价、extend/edit 定值、
 * 图片按分辨率两档、harness 长片按 5 秒基价折算。`priceCny` 的第二参数在多数用例里
 * 直接传自定义表，绕开 `LUMEN_PRICE_TABLE`，让公式本身的测试与环境变量解析解耦；
 * 环境变量合并 / 坏 JSON 回落单独在 `priceTable` 一节测。
 */

afterEach(() => {
  delete process.env.LUMEN_PRICE_TABLE;
  vi.restoreAllMocks();
});

describe("priceCny for video modes (t2v / i2v / r2v)", () => {
  it("prices 5s and anything under it at the short tier", () => {
    expect(priceCny({ mode: "text_to_video", durationSec: 5 }, DEFAULT_PRICE_TABLE)).toBe(2);
    expect(priceCny({ mode: "image_to_video", durationSec: 4 }, DEFAULT_PRICE_TABLE)).toBe(2);
    expect(priceCny({ mode: "reference_to_video", durationSec: 1 }, DEFAULT_PRICE_TABLE)).toBe(2);
  });

  it("prices anything over 5s (and not a harness duration) at the long tier", () => {
    expect(priceCny({ mode: "text_to_video", durationSec: 6 }, DEFAULT_PRICE_TABLE)).toBe(4);
    expect(priceCny({ mode: "text_to_video", durationSec: 8 }, DEFAULT_PRICE_TABLE)).toBe(4);
    expect(priceCny({ mode: "image_to_video", durationSec: 10 }, DEFAULT_PRICE_TABLE)).toBe(4);
  });

  it("treats a missing durationSec as 0, landing in the short tier", () => {
    expect(priceCny({ mode: "text_to_video" }, DEFAULT_PRICE_TABLE)).toBe(2);
  });

  it("multiplies by the 1080p rate, and adds the flat audio surcharge", () => {
    expect(priceCny({ mode: "text_to_video", durationSec: 5, resolution: "1080p" }, DEFAULT_PRICE_TABLE)).toBe(3);
    expect(priceCny({ mode: "text_to_video", durationSec: 8, resolution: "1080p" }, DEFAULT_PRICE_TABLE)).toBe(6);
    expect(priceCny({ mode: "text_to_video", durationSec: 5, generateAudio: true }, DEFAULT_PRICE_TABLE)).toBe(3);
    // Both stack: hd multiplies the base first, audio adds on top of that.
    expect(
      priceCny(
        { mode: "text_to_video", durationSec: 8, resolution: "1080p", generateAudio: true },
        DEFAULT_PRICE_TABLE,
      ),
    ).toBe(7);
  });

  it("does not apply the hd rate for 480p/720p, and does not add audio when it is false or absent", () => {
    expect(priceCny({ mode: "text_to_video", durationSec: 8, resolution: "720p" }, DEFAULT_PRICE_TABLE)).toBe(4);
    expect(priceCny({ mode: "text_to_video", durationSec: 8, generateAudio: false }, DEFAULT_PRICE_TABLE)).toBe(4);
  });
});

describe("priceCny for harness long-form durations (30 / 45 / 60s)", () => {
  it("packs 30s as 6 x the 5s base price = 12", () => {
    expect(priceCny({ mode: "text_to_video", durationSec: 30 }, DEFAULT_PRICE_TABLE)).toBe(12);
  });

  it("scales 45s and 60s the same way", () => {
    expect(priceCny({ mode: "image_to_video", durationSec: 45 }, DEFAULT_PRICE_TABLE)).toBe(18);
    expect(priceCny({ mode: "text_to_video", durationSec: 60 }, DEFAULT_PRICE_TABLE)).toBe(24);
  });

  it("still stacks the hd multiplier on top of the harness packing", () => {
    expect(
      priceCny({ mode: "text_to_video", durationSec: 30, resolution: "1080p" }, DEFAULT_PRICE_TABLE),
    ).toBe(18);
  });
});

describe("priceCny for the flat-rate modes", () => {
  it("prices extend_video at the fixed extend rate regardless of duration", () => {
    expect(priceCny({ mode: "extend_video", durationSec: 6 }, DEFAULT_PRICE_TABLE)).toBe(3);
    expect(priceCny({ mode: "extend_video", durationSec: 15 }, DEFAULT_PRICE_TABLE)).toBe(3);
    expect(priceCny({ mode: "extend_video" }, DEFAULT_PRICE_TABLE)).toBe(3);
  });

  it("prices edit_video at the fixed edit rate regardless of duration", () => {
    expect(priceCny({ mode: "edit_video", durationSec: 8 }, DEFAULT_PRICE_TABLE)).toBe(4);
    expect(priceCny({ mode: "edit_video" }, DEFAULT_PRICE_TABLE)).toBe(4);
  });

  it("ignores resolution/audio for extend and edit — they are not video-tier priced", () => {
    expect(
      priceCny({ mode: "extend_video", resolution: "1080p", generateAudio: true }, DEFAULT_PRICE_TABLE),
    ).toBe(3);
  });
});

describe("priceCny for text_to_image", () => {
  it("prices 1k and 2k at their own flat rates", () => {
    expect(priceCny({ mode: "text_to_image", imageResolution: "1k" }, DEFAULT_PRICE_TABLE)).toBe(0.5);
    expect(priceCny({ mode: "text_to_image", imageResolution: "2k" }, DEFAULT_PRICE_TABLE)).toBe(1);
  });

  it("defaults a missing imageResolution to the 1k price", () => {
    expect(priceCny({ mode: "text_to_image" }, DEFAULT_PRICE_TABLE)).toBe(0.5);
  });

  it("ignores durationSec entirely for images", () => {
    expect(priceCny({ mode: "text_to_image", imageResolution: "2k", durationSec: 999 }, DEFAULT_PRICE_TABLE)).toBe(1);
  });
});

describe("priceCny rounding", () => {
  it("rounds to 2 decimals even when the multiplication produces float noise", () => {
    const table: PriceTable = {
      video: { "5": 0.1, "10": 4, hd: 3, audio: 0.15 },
      extend: 3,
      edit: 4,
      image: { "1k": 0.5, "2k": 1 },
      // 智能体一轮的售价（2026-09-06 新增档）。这条用例只测视频档的浮点取整，
      // 但 `PriceTable` 是完整形状，缺一项就编译不过。
      agent: { turn: 0.05 },
    };
    // 0.1 * 3 is 0.30000000000000004 in raw IEEE754 float arithmetic.
    expect(priceCny({ mode: "text_to_video", durationSec: 5, resolution: "1080p" }, table)).toBe(0.3);
    // 0.1 + 0.15 is 0.25000000000000006 in raw float arithmetic.
    expect(priceCny({ mode: "text_to_video", durationSec: 5, generateAudio: true }, table)).toBe(0.25);
  });
});

describe("formatCny", () => {
  it("formats to two decimals with the yuan sign", () => {
    expect(formatCny(2)).toBe("¥2.00");
    expect(formatCny(0.5)).toBe("¥0.50");
    expect(formatCny(12)).toBe("¥12.00");
  });

  it("falls back to zero for a non-finite amount rather than printing NaN", () => {
    expect(formatCny(Number.NaN)).toBe("¥0.00");
    expect(formatCny(Number.POSITIVE_INFINITY)).toBe("¥0.00");
  });
});

describe("priceTable() and LUMEN_PRICE_TABLE", () => {
  it("returns the default table when the env var is unset", () => {
    delete process.env.LUMEN_PRICE_TABLE;
    expect(priceTable()).toEqual(DEFAULT_PRICE_TABLE);
  });

  it("merges a partial override on top of the default, leaving untouched fields alone", () => {
    process.env.LUMEN_PRICE_TABLE = JSON.stringify({ video: { "5": 3 }, image: { "2k": 1.5 } });
    const table = priceTable();
    expect(table.video).toEqual({ "5": 3, "10": 4, hd: 1.5, audio: 1 });
    expect(table.image).toEqual({ "1k": 0.5, "2k": 1.5 });
    expect(table.extend).toBe(3);
    expect(table.edit).toBe(4);
    // And priceCny actually picks the merged table up through its own default parameter.
    expect(priceCny({ mode: "text_to_video", durationSec: 5 })).toBe(3);
  });

  it("falls back to the default table and warns once when the JSON is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.LUMEN_PRICE_TABLE = '{"video":{"5":3},'; // truncated JSON
    expect(priceTable()).toEqual(DEFAULT_PRICE_TABLE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LUMEN_PRICE_TABLE");
  });

  it("falls back to the default table when the JSON parses but is not an object", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const raw of ["[]", '"nope"', "42"]) {
      process.env.LUMEN_PRICE_TABLE = raw;
      expect(priceTable()).toEqual(DEFAULT_PRICE_TABLE);
    }
  });

  it("discards negative or non-numeric entries instead of pricing a tier at zero or less", () => {
    process.env.LUMEN_PRICE_TABLE = JSON.stringify({ video: { "5": -1, "10": "four" } });
    const table = priceTable();
    expect(table.video["5"]).toBe(DEFAULT_PRICE_TABLE.video["5"]);
    expect(table.video["10"]).toBe(DEFAULT_PRICE_TABLE.video["10"]);
  });
});
