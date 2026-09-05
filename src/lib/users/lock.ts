type GlobalLockState = typeof globalThis & {
  __lumenUserLockTail?: Promise<void>;
};

const globalLockState = globalThis as GlobalLockState;

/**
 * Process-wide serial lock for user/invite mutations, mirroring
 * `src/lib/jobs/admission.ts`. Deliberately a *separate* lock: registration must
 * not queue behind job admission (or vice versa), and the two critical sections
 * never touch the same files.
 *
 * The tail lives on `globalThis` so a duplicated module instance (Next dev
 * bundles the same file into several graphs) still serializes.
 */
export async function withUserLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLockState.__lumenUserLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLockState.__lumenUserLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
