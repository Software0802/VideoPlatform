import { freeDailyFailureLimit, freeDailyImageQuota } from "@/lib/env";
import { listJobRecordsForUser } from "@/lib/jobs/store";
import { isTerminalStatus, type JobRecord, type JobStatus } from "@/lib/jobs/schema";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * Per-user daily image quota (plan §6).
 *
 * The model is *reserve + settle*, not after-the-fact counting:
 *
 *   used     = today's succeeded image jobs
 *   inFlight = every image job of this user still in a non-terminal state
 *   admitted = used + inFlight < limit
 *
 * A job that fails, is canceled or expires drops out of `inFlight` and never
 * becomes `used`, which is what makes "an upstream outage costs you nothing"
 * true; holding the reservation while the job runs is what stops five
 * concurrent submissions from all spending the last slot.
 *
 * Everything is counted live from `job.json` (plan §6.3): a second counter
 * would drift from the only source of truth we have.
 */

/** Plan §6.3: one fixed day boundary for everyone, no per-user time zone. */
export const QUOTA_TIME_ZONE = "Asia/Shanghai";

const DAY_MS = 86_400_000;

/** The fields quota counting needs — `JobRecord` satisfies it, tests can pass literals. */
export type QuotaJob = {
  ownerId?: string;
  mode: JobRecord["mode"];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  /** Stamped by `store.updateJob` on the first terminal transition; see `settledAtMs`. */
  completedAt?: string;
  /** Only `code` is read, to tell a user's failure from the platform's — see `BLAMELESS_FAILURE_CODES`. */
  error?: { code: string } | null;
};

/**
 * Failures the stop-loss valve must not count. The valve exists to stop *this user*
 * from burning the platform's money on a prompt that keeps failing; an upstream that
 * is out of credit or over its concurrency ceiling is the platform's problem, and an
 * interrupted submit is ours. Counting those would suspend an innocent account —
 * and, for `rate_limited`, suspend everyone at once exactly when the upstream hiccups.
 */
const BLAMELESS_FAILURE_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "quota_exhausted",
  "uncertain_submit",
]);

export type QuotaLimits = {
  limit: number;
  failureLimit: number;
};

export type QuotaUsage = QuotaLimits & {
  /** Today's succeeded image jobs. */
  used: number;
  /** Non-terminal image jobs holding a reservation (any day: yesterday's straggler still counts). */
  inFlight: number;
  remaining: number;
  /** Start of the next Asia/Shanghai day, ISO — what the UI shows as the reset time. */
  resetsAt: string;
  /** Today's failed + canceled image jobs, for the stop-loss valve only. */
  failures: number;
};

/** The stop-loss valve as the client sees it — the raw `failures` count stays server-side. */
export type QuotaStopLoss = { code: "failure_limit_reached"; message: string };

/** What `GET /api/me` exposes; `failures` and `failureLimit` stay server-side. */
export type QuotaPublic = Pick<QuotaUsage, "limit" | "used" | "inFlight" | "remaining" | "resetsAt"> & {
  /**
   * Non-null when the stop-loss valve is refusing new submissions, verbatim from
   * `quotaBlock` so the client is never told something `assertQuota` would
   * contradict. Running out of quota is *not* reported here — `remaining === 0`
   * already says that, and saying it twice invites the two to disagree.
   */
  blocked: QuotaStopLoss | null;
};

export type QuotaBlock = { code: "quota_exceeded" | "failure_limit_reached"; message: string };

const zonedParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: QUOTA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Milliseconds to add to a UTC instant to get the wall clock in `QUOTA_TIME_ZONE`.
 * Derived from `Intl` rather than hard-coded (+08:00) or guessed from
 * `toLocaleString`, so the boundary stays right if the zone database changes.
 */
function zoneOffsetMs(atMs: number): number {
  const parts = zonedParts.formatToParts(new Date(atMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((p) => p.type === type)?.value;
    return raw ? Number(raw) : 0;
  };
  // `hourCycle: "h23"` keeps midnight at 0 rather than the "24" some ICU builds emit.
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  // Offsets are whole seconds, so compare against the second-truncated instant.
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

function floorToZonedDay(atMs: number, offsetMs: number): number {
  return Math.floor((atMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
}

/** UTC instant of today's 00:00 in `QUOTA_TIME_ZONE`. */
export function dayStartMs(nowMs: number): number {
  const rough = floorToZonedDay(nowMs, zoneOffsetMs(nowMs));
  // Second pass with the offset actually in force at the candidate midnight. Asia/Shanghai
  // has had no DST since 1991, so this only matters if the zone ever gains one again.
  const exact = floorToZonedDay(nowMs, zoneOffsetMs(rough));
  return exact <= nowMs ? exact : rough;
}

/** `[startMs, endMs)` of the Asia/Shanghai day containing `nowMs`. */
export function dayWindow(nowMs: number): { startMs: number; endMs: number } {
  const startMs = dayStartMs(nowMs);
  // +25h lands inside the next day even if a day were ever 23 or 25 hours long.
  return { startMs, endMs: dayStartMs(startMs + 25 * 3_600_000) };
}

/**
 * Which day a settled job belongs to.
 *
 * Deliberately **not** `createdAt`: a job submitted at 23:59 Beijing and finished
 * at 00:05 has a yesterday `createdAt`, so bucketing by it would leave the job
 * counted on neither day — free of charge on the success side, and invisible to
 * the stop-loss valve on the failure side.
 *
 * `completedAt` is stamped once, on the first terminal transition. Records
 * written before the field existed fall back to `updatedAt`, which for a
 * finished job is the instant it finished.
 */
function settledAtMs(job: QuotaJob): number | null {
  const ms = Date.parse(job.completedAt ?? job.updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure counter: `nowMs` is injected so the day boundary can be tested without
 * waiting for midnight.
 *
 * Only jobs whose `ownerId` equals `ownerId` are counted. Ownerless jobs from
 * before the user system are visible to the administrator (`canAccessJob`) but
 * belong to nobody's quota.
 */
export function computeQuotaUsage(
  jobs: readonly QuotaJob[],
  ownerId: string,
  nowMs: number,
  limits: QuotaLimits,
): QuotaUsage {
  const { startMs, endMs } = dayWindow(nowMs);
  let used = 0;
  let inFlight = 0;
  let failures = 0;

  for (const job of jobs) {
    if (job.ownerId !== ownerId) continue;
    if (!isImageMode(job.mode)) continue;
    if (!isTerminalStatus(job.status)) {
      // A reservation is held regardless of the day it was made: a job started
      // yesterday and still running is spending an upstream call right now.
      inFlight += 1;
      continue;
    }
    const settled = settledAtMs(job);
    if (settled === null || settled < startMs || settled >= endMs) continue;
    if (job.status === "succeeded") used += 1;
    else if (
      (job.status === "failed" || job.status === "canceled") &&
      !BLAMELESS_FAILURE_CODES.has(job.error?.code ?? "")
    ) {
      failures += 1;
    }
  }

  return {
    ...limits,
    used,
    inFlight,
    remaining: Math.max(0, limits.limit - used - inFlight),
    resetsAt: new Date(endMs).toISOString(),
    failures,
  };
}

/**
 * Why this submission must be refused, or null. The stop-loss valve is checked
 * first: at that point "今日已用 n/10" would be the wrong explanation, since
 * failures never consumed quota in the first place.
 *
 * Messages never name a user id — they are shown verbatim to the client.
 */
export function quotaBlock(usage: QuotaUsage): QuotaBlock | null {
  if (usage.failures >= usage.failureLimit) {
    return {
      code: "failure_limit_reached",
      message: `今日失败与取消已达 ${usage.failureLimit} 次，暂停新提交，请联系管理员`,
    };
  }
  const consumed = usage.used + usage.inFlight;
  if (consumed >= usage.limit) {
    return {
      code: "quota_exceeded",
      message: `今日已用 ${Math.min(consumed, usage.limit)}/${usage.limit}，北京时间 0 点重置`,
    };
  }
  return null;
}

export function publicQuota(usage: QuotaUsage): QuotaPublic {
  // Reuse the admission judge rather than re-deriving the condition: `/api/me`
  // saying "还剩 10 次" while `assertQuota` refuses every submission is exactly
  // the divergence this reuse rules out.
  const block = quotaBlock(usage);
  return {
    limit: usage.limit,
    used: usage.used,
    inFlight: usage.inFlight,
    remaining: usage.remaining,
    resetsAt: usage.resetsAt,
    blocked:
      block?.code === "failure_limit_reached" ? { code: block.code, message: block.message } : null,
  };
}

/** Live count for one user, straight from `job.json`. */
export async function loadQuotaUsage(ownerId: string, nowMs: number = Date.now()): Promise<QuotaUsage> {
  const jobs = await listJobRecordsForUser(ownerId);
  return computeQuotaUsage(jobs, ownerId, nowMs, {
    limit: freeDailyImageQuota(),
    failureLimit: freeDailyFailureLimit(),
  });
}

/**
 * The single admission judge, shared by `createJob` and `retryJob` (plan §6.2) —
 * a retry sends a fresh, billable upstream request, so it spends a slot exactly
 * like a new submission.
 *
 * MUST be called inside `withAdmissionLock`, in the same critical section as the
 * `job.json` write it guards: outside it, five concurrent requests all read the
 * same "one slot left" and all pass.
 *
 * Only image jobs are metered — video has no per-day quota this round.
 */
export async function assertQuota(
  ownerId: string,
  mode: JobRecord["mode"],
  nowMs: number = Date.now(),
): Promise<void> {
  if (!isImageMode(mode)) return;
  const block = quotaBlock(await loadQuotaUsage(ownerId, nowMs));
  if (block) throw new ProviderHttpError(429, block.code, block.message);
}
