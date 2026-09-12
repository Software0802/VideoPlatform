type GlobalAdmissionLock = typeof globalThis & { __lumenAdmissionLockTail?: Promise<void> };
const globalLock = globalThis as GlobalAdmissionLock;

/**
 * 全局准入串行锁（配额 / 余额判定 / run 冻结的临界区）。`tail` 挂
 * `globalThis`：Next dev 会把同一模块打进多张模块图，模块级变量会裂成
 * 两条互不相干的临界区——与 `run-store.ts` 的 run 锁同一条纪律。
 */
export async function withAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLock.__lumenAdmissionLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLock.__lumenAdmissionLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
