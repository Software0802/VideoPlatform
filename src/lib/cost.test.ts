import { describe, expect, it } from "vitest";
import {
  estimateHarnessCostUsd,
  estimateHarnessRetryBudgetUsd,
  estimateCostUsd,
  ticksToUsd,
} from "./cost";

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
