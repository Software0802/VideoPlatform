type GlobalLockState = typeof globalThis & {
  __lumenRelayLockTail?: Promise<void>;
};

const globalLockState = globalThis as GlobalLockState;

/**
 * Process-wide serial lock for `data/relays.json` read-modify-write, mirroring
 * `src/lib/users/lock.ts`. Deliberately a *separate* lock: relay admin mutations
 * must not queue behind job admission or user locks (and vice versa) — the three
 * critical sections never touch the same files, so this changes no lock ordering.
 *
 * The tail lives on `globalThis` so a duplicated module instance (Next dev
 * bundles the same file into several graphs) still serializes.
 */
export async function withRelayLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLockState.__lumenRelayLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLockState.__lumenRelayLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
