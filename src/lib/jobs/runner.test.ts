import { describe, expect, it } from "vitest";
import { pollDelayMs } from "./runner";

/**
 * 轮询阶梯（方案 §3.3「轮询」，P4）：前 20 秒固定 2s，20→60 秒线性升到 5s，之后按
 * （可调的）上限走。`pollDelayMs` 是这条阶梯抽出来的纯函数，`maxMs` 作为显式参数注入，
 * 不必依赖 `upstreamPollMaxMs()` 的环境变量默认值就能测全部分支，包括「上限调得比 2 秒
 * 还小时，全程都按它走，不留一个隐藏的 2 秒下限」这条头部注释里明确写的行为。
 */

const MAX = 10_000; // an arbitrary, generous ceiling used across most cases below

describe("pollDelayMs", () => {
  it("stays flat at 2s for the first 20 seconds", () => {
    expect(pollDelayMs(0, MAX)).toBe(2000);
    expect(pollDelayMs(1, MAX)).toBe(2000);
    expect(pollDelayMs(19_999, MAX)).toBe(2000);
  });

  it("ramps linearly from 2s to 5s between 20s and 60s, continuous at both ends", () => {
    expect(pollDelayMs(20_000, MAX)).toBe(2000); // ramp start: ratio 0, same as the flat zone
    expect(pollDelayMs(40_000, MAX)).toBe(3500); // exact midpoint: ratio 0.5
    // ratio = 39_999/40_000 = 0.999975 -> raw = 4999.925 -> rounds to 5000, same as the top.
    expect(pollDelayMs(59_999, MAX)).toBe(5000);
  });

  it("rounds a fractional ramp value to the nearest millisecond", () => {
    // ratio = (30_001 - 20_000) / 40_000 = 0.250025 -> raw = 2750.075 -> rounds to 2750
    expect(pollDelayMs(30_001, MAX)).toBe(2750);
  });

  it("jumps to the ceiling once elapsed reaches 60s, even when that is above the 5s ramp top", () => {
    expect(pollDelayMs(60_000, MAX)).toBe(MAX);
    expect(pollDelayMs(999_999, MAX)).toBe(MAX);
  });

  it("never returns a value above maxMs, even mid-ramp", () => {
    // At elapsedMs=40_000 the ramp alone would want 3500ms; a tighter ceiling wins.
    expect(pollDelayMs(40_000, 3000)).toBe(3000);
  });

  it("holds at maxMs for the entire lifetime when maxMs is below the 2s base — no hidden 2s floor", () => {
    const tinyMax = 500;
    expect(pollDelayMs(0, tinyMax)).toBe(tinyMax);
    expect(pollDelayMs(19_999, tinyMax)).toBe(tinyMax);
    expect(pollDelayMs(40_000, tinyMax)).toBe(tinyMax);
    expect(pollDelayMs(999_999, tinyMax)).toBe(tinyMax);
  });

  it("falls back to upstreamPollMaxMs() when maxMs is not supplied", () => {
    // Only asserting it resolves to *some* finite, positive delay well past the ramp —
    // the exact env-derived default belongs to env.ts's own tests, not this one.
    const delay = pollDelayMs(999_999);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
  });
});
