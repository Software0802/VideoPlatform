import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateHarnessCostUsd,
  estimateHarnessRetryBudgetUsd,
  estimateCostUsd,
  estimateOpenaiImageCostUsd,
  imageSizeTier,
  openaiImagePriceTable,
  ticksToUsd,
  UNKNOWN_IMAGE_ESTIMATE_USD,
} from "./cost";

/** 实测的 ccgoai gpt-image-2 价目（元/张，1K 与 2K 同价）。 */
const CCGOAI_TABLE = JSON.stringify({
  low: { "1K": 0.08, "2K": 0.08, "4K": 0.1 },
  medium: { "1K": 0.13, "2K": 0.13, "4K": 0.15 },
  high: { "1K": 0.2, "2K": 0.2, "4K": 0.23 },
});

afterEach(() => {
  delete process.env.OPENAI_IMAGE_PRICE_TABLE;
  vi.restoreAllMocks();
});

describe("cost", () => {
  it("8s 1.5 is $0.64", () => {
    expect(estimateCostUsd("grok-imagine-video-1.5", 8)).toBe(0.64);
  });
  it("15s 1.5 is $1.20", () => {
    expect(estimateCostUsd("grok-imagine-video-1.5", 15)).toBe(1.2);
  });
  it("maps ticks", () => {
    expect(ticksToUsd(6_400_000_000)).toBe(0.64);
  });
  it("estimates the documented 30s hybrid packing", () => {
    const clips = [
      { kind: "generate" as const, durationSec: 15 },
      { kind: "extend" as const, durationSec: 10 },
      { kind: "generate" as const, durationSec: 5 },
    ];
    expect(estimateHarnessCostUsd(clips)).toBe(2.1);
    expect(estimateHarnessRetryBudgetUsd(clips)).toBe(3.15);
  });

  it("estimates 60s from explicit clips and rejects an overlong extend", () => {
    const clips = [
      { kind: "generate" as const, durationSec: 15 },
      { kind: "extend" as const, durationSec: 10 },
      { kind: "generate" as const, durationSec: 15 },
      { kind: "extend" as const, durationSec: 10 },
      { kind: "generate" as const, durationSec: 10 },
    ];
    expect(estimateHarnessCostUsd(clips)).toBe(4.2);
    expect(() =>
      estimateHarnessCostUsd([{ kind: "extend", durationSec: 11 }]),
    ).toThrow("非法 Harness clip");
    expect(() =>
      estimateHarnessCostUsd([{ kind: "unknown" as "generate", durationSec: 5 }]),
    ).toThrow("非法 Harness clip");
  });

  it("image is flat $0.02", () => {
    expect(estimateCostUsd("grok-imagine-image-2.0", 0)).toBe(0.02);
    expect(estimateCostUsd("grok-imagine-image-2.0", 8)).toBe(0.02);
  });
});

describe("imageSizeTier", () => {
  it("brackets on the longest side at 1024 / 2048", () => {
    expect(imageSizeTier("1024x1024")).toBe("1K");
    expect(imageSizeTier("1024x576")).toBe("1K");
    expect(imageSizeTier("1025x1024")).toBe("2K");
    expect(imageSizeTier("2048x1152")).toBe("2K");
    expect(imageSizeTier("1344x2016")).toBe("2K");
    expect(imageSizeTier("2049x1024")).toBe("4K");
    expect(imageSizeTier("1024x2049")).toBe("4K");
    expect(imageSizeTier("3840x2160")).toBe("4K");
  });

  it("books an unreadable or upstream-chosen size at 2K rather than the cheapest tier", () => {
    for (const size of ["auto", "", "  ", "big", "1024", "0x0"]) {
      expect(imageSizeTier(size)).toBe("2K");
    }
  });
});

describe("OPENAI_IMAGE_PRICE_TABLE", () => {
  it("parses the ccgoai table and prices by quality × size tier, ignoring tokens", () => {
    process.env.OPENAI_IMAGE_PRICE_TABLE = CCGOAI_TABLE;
    expect(openaiImagePriceTable()).toEqual({
      low: { "1K": 0.08, "2K": 0.08, "4K": 0.1 },
      medium: { "1K": 0.13, "2K": 0.13, "4K": 0.15 },
      high: { "1K": 0.2, "2K": 0.2, "4K": 0.23 },
    });

    // 4160 output tokens would be $0.1664 under the official token rule; the table wins.
    expect(estimateOpenaiImageCostUsd({ size: "2048x1152", quality: "high", outputTokens: 4160 })).toBe(0.2);
    expect(estimateOpenaiImageCostUsd({ size: "1024x576", quality: "low" })).toBe(0.08);
    expect(estimateOpenaiImageCostUsd({ size: "3840x2160", quality: "medium" })).toBe(0.15);
  });

  it("books an unlisted quality at the dearest price of that tier", () => {
    process.env.OPENAI_IMAGE_PRICE_TABLE = CCGOAI_TABLE;
    expect(estimateOpenaiImageCostUsd({ size: "2048x2048", quality: "auto" })).toBe(0.2);
    expect(estimateOpenaiImageCostUsd({ size: "3840x2160", quality: "auto" })).toBe(0.23);
  });

  it("warns once and falls back to the token rule when the JSON is broken", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.OPENAI_IMAGE_PRICE_TABLE = '{"low":{"1K":0.08},'; // truncated
    expect(openaiImagePriceTable()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("OPENAI_IMAGE_PRICE_TABLE");

    // 4160 × $40/M — the official口径 is intact.
    expect(estimateOpenaiImageCostUsd({ size: "2048x1152", quality: "high", outputTokens: 4160 })).toBeCloseTo(0.1664, 6);
    expect(estimateOpenaiImageCostUsd({ size: "1024x1024", quality: "low" })).toBe(0.011);
  });

  it("rejects a table with no usable numbers instead of pricing everything at zero", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const raw of ["[]", '"nope"', "42", '{"low":"cheap"}', '{"low":{"5K":1}}', "{}"]) {
      process.env.OPENAI_IMAGE_PRICE_TABLE = raw;
      expect(openaiImagePriceTable()).toBeNull();
    }
  });

  it("keeps the official token口径 when the table is unset", () => {
    expect(estimateOpenaiImageCostUsd({ size: "1024x1024", quality: "high", outputTokens: 4160 })).toBeCloseTo(
      0.1664,
      6,
    );
    expect(estimateOpenaiImageCostUsd({ size: "1536x1024", quality: "high" })).toBe(0.25);
  });
});

describe("estimateCostUsd for image models", () => {
  it("never books a gpt-image-2 submit at 0", () => {
    // The regression: gpt-image-2 is in no local table, so it used to fall into the
    // per-second video branch with durationSec 0.
    expect(estimateCostUsd("gpt-image-2", 0)).toBe(UNKNOWN_IMAGE_ESTIMATE_USD);
    expect(estimateCostUsd("gpt-image-2", 0)).toBeGreaterThan(0);
    expect(estimateCostUsd("gpt-image-2", 0, { size: "2048x1152", quality: "high" })).toBeGreaterThan(0);
  });

  it("estimates from the price table when one is configured", () => {
    process.env.OPENAI_IMAGE_PRICE_TABLE = CCGOAI_TABLE;
    expect(estimateCostUsd("gpt-image-2", 0, { size: "2048x1152", quality: "high" })).toBe(0.2);
    expect(estimateCostUsd("gpt-image-2", 0, { size: "1024x576", quality: "low" })).toBe(0.08);
    // A known model does not get to be cheaper than the table says either.
    expect(estimateCostUsd("gpt-image-1", 0, { size: "1024x1024", quality: "medium" })).toBe(0.13);
  });

  it("keeps the official lower bound for gpt-image-1 with no table", () => {
    expect(estimateCostUsd("gpt-image-1", 0)).toBe(0.011);
    expect(estimateCostUsd("gpt-image-1", 0, { size: "1536x1024", quality: "high" })).toBe(0.011);
  });

  it("leaves the video path untouched", () => {
    expect(estimateCostUsd("grok-imagine-video-1.5", 8)).toBe(0.64);
    expect(estimateCostUsd("grok-imagine-video", 8)).toBe(0.4);
  });
});
