type AdmissionSample = { waitMs: number; holdMs: number; at: number };

type GlobalAdmissionLock = typeof globalThis & {
  __lumenAdmissionLockTail?: Promise<void>;
  __lumenAdmissionSamples?: AdmissionSample[];
};
const globalLock = globalThis as GlobalAdmissionLock;

const SAMPLE_CAP = 256;

export type AdmissionQuantiles = { p50Ms: number; p95Ms: number; maxMs: number };

export type AdmissionStats = {
  samples: number;
  wait: AdmissionQuantiles;
  hold: AdmissionQuantiles;
};

/**
 * 全局准入串行锁（配额 / 余额判定 / run 冻结的临界区）。`tail` 挂
 * `globalThis`：Next dev 会把同一模块打进多张模块图，模块级变量会裂成
 * 两条互不相干的临界区——与 `run-store.ts` 的 run 锁同一条纪律。
 *
 * R4.1：顺带记录「等锁 / 持锁」两段耗时（`admission_ms` 的两半），样本存
 * `globalThis` 上容量 256 的环形数组，经 `admissionStats()` 由 `/api/health`
 * 登录态暴露——它是 F-09「准入 IO 随历史线性增长」的观测入口。
 */
export async function withAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLock.__lumenAdmissionLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLock.__lumenAdmissionLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queuedAt = performance.now();
  await previous;
  const acquiredAt = performance.now();
  try {
    return await fn();
  } finally {
    const samples = (globalLock.__lumenAdmissionSamples ??= []);
    samples.push({ waitMs: acquiredAt - queuedAt, holdMs: performance.now() - acquiredAt, at: Date.now() });
    if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
    release();
  }
}

function quantiles(values: number[]): AdmissionQuantiles {
  const sorted = [...values].sort((a, b) => a - b);
  // 最近邻排名法：sorted[ceil(p·n)-1]
  const pick = (p: number) => Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 10) / 10;
  return { p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10 };
}

/** 最近 256 次准入的等锁 / 持锁分位数；一个样本都没有时回 null。 */
export function admissionStats(): AdmissionStats | null {
  const samples = globalLock.__lumenAdmissionSamples;
  if (!samples || samples.length === 0) return null;
  return {
    samples: samples.length,
    wait: quantiles(samples.map((s) => s.waitMs)),
    hold: quantiles(samples.map((s) => s.holdMs)),
  };
}

export function __resetAdmissionStatsForTests(): void {
  globalLock.__lumenAdmissionSamples = [];
}
