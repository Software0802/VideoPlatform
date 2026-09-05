/**
 * Process-local sliding window for the login/register endpoints (plan §7).
 * The only in-memory state in the user system: a restart clears it, which is
 * acceptable for an anti-credential-stuffing speed bump on a single instance.
 */
export const AUTH_RATE_LIMIT = 10;
export const AUTH_RATE_WINDOW_MS = 60_000;

/** Stop tracking keys once the map grows past this; prevents unbounded growth. */
const MAX_TRACKED_KEYS = 5_000;

type GlobalRateState = typeof globalThis & { __lumenAuthRate?: Map<string, number[]> };
const globalRateState = globalThis as GlobalRateState;

function buckets(): Map<string, number[]> {
  return (globalRateState.__lumenAuthRate ??= new Map());
}

export type RateLimitOptions = {
  limit?: number;
  windowMs?: number;
  now?: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the oldest hit leaves the window; 0 when allowed. */
  retryAfterSec: number;
};

/**
 * Consume one slot from every key. A rejected attempt is *not* recorded, so a
 * client that keeps hammering cannot extend its own lockout indefinitely.
 * Keys are independent buckets — "IP + email" means both an address and an
 * account get their own budget, so rotating one does not buy a fresh quota.
 */
export function consumeRateLimit(keys: string[], options: RateLimitOptions = {}): RateLimitResult {
  const limit = options.limit ?? AUTH_RATE_LIMIT;
  const windowMs = options.windowMs ?? AUTH_RATE_WINDOW_MS;
  const now = options.now ?? Date.now();
  const map = buckets();
  const cutoff = now - windowMs;

  const pruned: [string, number[]][] = [];
  let blockedUntil = 0;
  for (const key of keys) {
    const hits = (map.get(key) ?? []).filter((t) => t > cutoff);
    pruned.push([key, hits]);
    if (hits.length >= limit) blockedUntil = Math.max(blockedUntil, hits[0] + windowMs);
  }

  if (blockedUntil > 0) {
    // Persist the pruning so expired entries do not accumulate.
    for (const [key, hits] of pruned) {
      if (hits.length === 0) map.delete(key);
      else map.set(key, hits);
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
  }

  if (map.size > MAX_TRACKED_KEYS) sweep(map, cutoff);
  for (const [key, hits] of pruned) {
    hits.push(now);
    map.set(key, hits);
  }
  return { allowed: true, retryAfterSec: 0 };
}

function sweep(map: Map<string, number[]>, cutoff: number): void {
  for (const [key, hits] of map) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length === 0) map.delete(key);
    else map.set(key, kept);
  }
  // Still oversized after pruning: drop everything rather than leak memory.
  if (map.size > MAX_TRACKED_KEYS) map.clear();
}

export function resetRateLimits(): void {
  buckets().clear();
}

/** Best-effort client address. Behind Caddy the first XFF hop is the real client. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function authRateKeys(request: Request, action: string, email: string): string[] {
  return [`${action}:ip:${clientIp(request)}`, `${action}:email:${email}`];
}
