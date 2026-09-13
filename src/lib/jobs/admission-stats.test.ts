import { beforeEach, describe, expect, it } from "vitest";
import { __resetAdmissionStatsForTests, admissionStats, withAdmissionLock } from "./admission";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  __resetAdmissionStatsForTests();
});

describe("admissionStats", () => {
  it("returns null before any admission ran", () => {
    expect(admissionStats()).toBeNull();
  });

  it("records wait/hold samples with monotone quantiles and hold ≥ fn 耗时", async () => {
    // 并发才有等锁：p2 进锁时 p1 还持着，waitMs 应覆盖 p1 的 5ms 持锁。
    const p1 = withAdmissionLock(async () => {
      await sleep(5);
    });
    const p2 = withAdmissionLock(async () => {
      await sleep(20);
    });
    await Promise.all([p1, p2]);

    const stats = admissionStats();
    expect(stats).not.toBeNull();
    expect(stats!.samples).toBe(2);
    for (const q of [stats!.wait, stats!.hold]) {
      expect(q.p50Ms).toBeLessThanOrEqual(q.p95Ms);
      expect(q.p95Ms).toBeLessThanOrEqual(q.maxMs);
    }
    // 持锁时间至少包住 fn 的睡眠（留 1ms 计时粒度余量）。
    expect(stats!.hold.maxMs).toBeGreaterThanOrEqual(19);
    expect(stats!.hold.p50Ms).toBeGreaterThanOrEqual(4);
    // 等锁：第二个调用等了第一个的 5ms 持锁。
    expect(stats!.wait.maxMs).toBeGreaterThanOrEqual(4);
    // 每 0.1ms 一档。
    expect(Number.isInteger(stats!.hold.maxMs * 10)).toBe(true);
  });

  it("keeps only the newest 256 samples", async () => {
    for (let i = 0; i < 257; i += 1) {
      await withAdmissionLock(async () => {});
    }
    const stats = admissionStats();
    expect(stats!.samples).toBe(256);
  });
});
