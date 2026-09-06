import { describe, expect, it } from "vitest";
import { computeQuotaUsage, dayWindow, publicQuota, quotaBlock, type QuotaJob } from "./quota";

/**
 * Pure side of the daily quota (plan §6.1 / §6.3). Everything here injects
 * `now`, so the Asia/Shanghai day boundary is testable without waiting for
 * midnight or touching the machine's own time zone.
 */

const OWNER = "usr_00000000000000a1";
const OTHER = "usr_00000000000000b2";
const LIMITS = { limit: 10, failureLimit: 30 };

/** 2026-09-05 23:59:59.999 Beijing — the last instant of that Beijing day. */
const LAST_MS = Date.parse("2026-09-05T15:59:59.999Z");
/** 2026-09-06 00:00:00.000 Beijing — one millisecond later, a new Beijing day. */
const NEXT_MS = Date.parse("2026-09-05T16:00:00.000Z");

/**
 * A job that was submitted *and* settled at the same instant. `settledAt`
 * overrides only the pair that decides which day it counts on, so a test can say
 * "finished after midnight" without restating the whole record.
 */
function job(overrides: Partial<QuotaJob> & { settledAt?: string } = {}): QuotaJob {
  const { settledAt, ...rest } = overrides;
  const at = new Date(LAST_MS).toISOString();
  return {
    ownerId: OWNER,
    mode: "text_to_image",
    status: "succeeded",
    createdAt: at,
    updatedAt: settledAt ?? at,
    completedAt: settledAt ?? at,
    ...rest,
  };
}

function usage(jobs: QuotaJob[], nowMs: number) {
  return computeQuotaUsage(jobs, OWNER, nowMs, LIMITS);
}

describe("Asia/Shanghai day window", () => {
  it("puts 15:59:59Z and 16:00:00Z UTC on different Beijing days", () => {
    const before = dayWindow(LAST_MS);
    expect(new Date(before.startMs).toISOString()).toBe("2026-09-04T16:00:00.000Z");
    expect(new Date(before.endMs).toISOString()).toBe("2026-09-05T16:00:00.000Z");

    const after = dayWindow(NEXT_MS);
    expect(new Date(after.startMs).toISOString()).toBe("2026-09-05T16:00:00.000Z");
    expect(new Date(after.endMs).toISOString()).toBe("2026-09-06T16:00:00.000Z");
  });

  it("is a half-open 24h window whose start is itself inside the day", () => {
    const { startMs, endMs } = dayWindow(NEXT_MS);
    expect(endMs - startMs).toBe(86_400_000);
    expect(dayWindow(startMs).startMs).toBe(startMs);
    expect(dayWindow(endMs).startMs).toBe(endMs);
    expect(dayWindow(endMs - 1).startMs).toBe(startMs);
  });

  it("reports the next Beijing midnight as the reset time", () => {
    expect(usage([], LAST_MS).resetsAt).toBe("2026-09-05T16:00:00.000Z");
    expect(usage([], NEXT_MS).resetsAt).toBe("2026-09-06T16:00:00.000Z");
  });
});

describe("computeQuotaUsage", () => {
  it("counts today's succeeded image jobs as used", () => {
    const jobs = Array.from({ length: 3 }, () => job());
    const now = usage(jobs, LAST_MS);
    expect(now).toMatchObject({ used: 3, inFlight: 0, failures: 0, remaining: 7 });
  });

  it("resets used at Beijing midnight but keeps in-flight reservations", () => {
    const jobs = [
      ...Array.from({ length: 10 }, () => job()),
      job({ status: "pending" }),
    ];

    const before = usage(jobs, LAST_MS);
    expect(before).toMatchObject({ used: 10, inFlight: 1, remaining: 0 });
    expect(quotaBlock(before)?.code).toBe("quota_exceeded");

    // One millisecond later it is a new Beijing day: yesterday's successes stop
    // counting, but the job that is still running keeps holding its slot.
    const after = usage(jobs, NEXT_MS);
    expect(after).toMatchObject({ used: 0, inFlight: 1, failures: 0, remaining: 9 });
    expect(quotaBlock(after)).toBeNull();
  });

  it("does not let failed, canceled or expired jobs consume quota", () => {
    const jobs = [
      job({ status: "failed" }),
      job({ status: "canceled" }),
      job({ status: "expired" }),
      job({ status: "succeeded" }),
    ];
    expect(usage(jobs, LAST_MS)).toMatchObject({ used: 1, inFlight: 0, remaining: 9 });
  });

  it("counts today's failed and canceled jobs for the stop-loss valve only", () => {
    const jobs = [
      job({ status: "failed" }),
      job({ status: "canceled" }),
      job({ status: "expired" }),
      // Yesterday's failure is outside the window.
      job({ status: "failed", settledAt: "2026-09-04T15:00:00.000Z" }),
    ];
    expect(usage(jobs, LAST_MS)).toMatchObject({ failures: 2, used: 0, remaining: 10 });
  });

  it("treats every non-terminal status as an in-flight reservation, whatever day it started", () => {
    const jobs = [
      job({ status: "queued" }),
      job({ status: "submitting" }),
      job({ status: "pending" }),
      job({ status: "persisting" }),
      // Started yesterday and still running: it is spending an upstream call right now.
      job({ status: "pending", createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(usage(jobs, LAST_MS)).toMatchObject({ used: 0, inFlight: 5, remaining: 5 });
  });

  it("ignores other users, ownerless jobs and non-image modes", () => {
    const jobs = [
      job({ ownerId: OTHER }),
      job({ ownerId: undefined }),
      job({ mode: "text_to_video" }),
      job({ mode: "image_to_video", status: "pending" }),
      job(),
    ];
    expect(usage(jobs, LAST_MS)).toMatchObject({ used: 1, inFlight: 0, remaining: 9 });
  });

  it("ignores a record with an unparseable settle time instead of counting it", () => {
    expect(usage([job({ settledAt: "not-a-date" })], LAST_MS)).toMatchObject({ used: 0 });
  });

  it("never reports negative remaining when the limit is lowered", () => {
    const jobs = Array.from({ length: 4 }, () => job());
    expect(computeQuotaUsage(jobs, OWNER, LAST_MS, { limit: 2, failureLimit: 30 })).toMatchObject({
      used: 4,
      remaining: 0,
    });
  });
});

describe("quotaBlock", () => {
  it("passes while a slot is free", () => {
    expect(quotaBlock(usage(Array.from({ length: 9 }, () => job()), LAST_MS))).toBeNull();
  });

  it("refuses with quota_exceeded and names the Beijing reset", () => {
    const block = quotaBlock(usage(Array.from({ length: 10 }, () => job()), LAST_MS));
    expect(block?.code).toBe("quota_exceeded");
    expect(block?.message).toBe("今日已用 10/10，北京时间 0 点重置");
  });

  it("caps the message at the limit when reservations overshoot it", () => {
    const jobs = [...Array.from({ length: 10 }, () => job()), job({ status: "queued" })];
    expect(quotaBlock(usage(jobs, LAST_MS))?.message).toBe("今日已用 10/10，北京时间 0 点重置");
  });

  it("trips the stop-loss valve independently of the quota", () => {
    const jobs = Array.from({ length: 30 }, () => job({ status: "failed" }));
    const state = usage(jobs, LAST_MS);
    // Failures consumed no quota at all …
    expect(state).toMatchObject({ used: 0, inFlight: 0, remaining: 10, failures: 30 });
    // … yet new submissions stop.
    const block = quotaBlock(state);
    expect(block?.code).toBe("failure_limit_reached");
    expect(block?.message).toContain("联系管理员");
  });

  it("never leaks a user id into a message", () => {
    const full = quotaBlock(usage(Array.from({ length: 10 }, () => job()), LAST_MS));
    const stopped = quotaBlock(usage(Array.from({ length: 30 }, () => job({ status: "failed" })), LAST_MS));
    expect(full?.message).not.toContain(OWNER);
    expect(stopped?.message).not.toContain(OWNER);
  });
});

describe("publicQuota", () => {
  it("exposes the five UI fields and keeps the failure counter server-side", () => {
    const shaped = publicQuota(usage([job(), job({ status: "pending" }), job({ status: "failed" })], LAST_MS));
    expect(shaped).toEqual({
      limit: 10,
      used: 1,
      inFlight: 1,
      remaining: 8,
      resetsAt: "2026-09-05T16:00:00.000Z",
      blocked: null,
    });
    expect(Object.keys(shaped)).not.toContain("failures");
    expect(Object.keys(shaped)).not.toContain("failureLimit");
  });

  it("reports the stop-loss valve verbatim, while remaining still tells the truth", () => {
    const jobs = Array.from({ length: 30 }, () => job({ status: "failed" }));
    const state = usage(jobs, LAST_MS);
    const shaped = publicQuota(state);

    // 30 failures consumed no quota, so `remaining` must not pretend otherwise …
    expect(shaped.remaining).toBe(10);
    // … but the client would still be refused, and now it is told why.
    expect(shaped.blocked).toEqual({
      code: "failure_limit_reached",
      message: quotaBlock(state)!.message,
    });
  });

  it("leaves blocked null when it is the quota, not the valve, that is exhausted", () => {
    const state = usage(Array.from({ length: 10 }, () => job()), LAST_MS);
    // `remaining: 0` already says this; duplicating it into `blocked` would give
    // the client two fields that can disagree.
    expect(quotaBlock(state)?.code).toBe("quota_exceeded");
    expect(publicQuota(state)).toMatchObject({ remaining: 0, blocked: null });
  });
});

/**
 * Finding 1: a job submitted at 23:59 Beijing and settled at 00:05 used to be
 * bucketed by `createdAt`, so it counted on neither day — a free image on the
 * success side, and a failure the stop-loss valve never saw.
 */
describe("jobs that cross midnight", () => {
  /** 2026-09-05 23:59 Beijing. */
  const SUBMITTED = "2026-09-05T15:59:00.000Z";
  /** 2026-09-06 00:05 Beijing — six minutes later, the next Beijing day. */
  const SETTLED = "2026-09-05T16:05:00.000Z";

  const crossed = (status: QuotaJob["status"]): QuotaJob =>
    job({ status, createdAt: SUBMITTED, settledAt: SETTLED });

  it("counts a success against the day it finished, not the day it started", () => {
    const jobs = [crossed("succeeded")];
    // Yesterday it was still in flight, so it counted nowhere as used …
    expect(usage(jobs, LAST_MS)).toMatchObject({ used: 0, failures: 0 });
    // … and today it is used, rather than escaping both days.
    expect(usage(jobs, NEXT_MS)).toMatchObject({ used: 1, remaining: 9 });
  });

  it("counts a cross-midnight failure or cancel against the day it finished", () => {
    const jobs = [crossed("failed"), crossed("canceled")];
    expect(usage(jobs, NEXT_MS)).toMatchObject({ used: 0, remaining: 10, failures: 2 });
  });

  it("still trips the stop-loss valve when every failure crossed midnight", () => {
    const jobs = Array.from({ length: 30 }, () => crossed("failed"));
    expect(quotaBlock(usage(jobs, NEXT_MS))?.code).toBe("failure_limit_reached");
  });

  it("falls back to updatedAt for records written before completedAt existed", () => {
    const legacy: QuotaJob = {
      ownerId: OWNER,
      mode: "text_to_image",
      status: "succeeded",
      createdAt: SUBMITTED,
      updatedAt: SETTLED,
    };
    expect(legacy.completedAt).toBeUndefined();
    expect(usage([legacy], NEXT_MS)).toMatchObject({ used: 1 });
    expect(usage([legacy], LAST_MS)).toMatchObject({ used: 0 });
  });

  it("prefers completedAt over updatedAt when both are present", () => {
    // A later write (a cost correction, a future artifact sweep) moves
    // `updatedAt` but must not move the job to another day.
    const swept: QuotaJob = {
      ownerId: OWNER,
      mode: "text_to_image",
      status: "succeeded",
      createdAt: SUBMITTED,
      completedAt: SETTLED,
      updatedAt: "2026-09-20T03:00:00.000Z",
    };
    expect(usage([swept], NEXT_MS)).toMatchObject({ used: 1 });
  });
});

/**
 * The stop-loss valve exists to stop *this user* from burning the platform's money on
 * a prompt that keeps failing. `rate_limited` / `quota_exhausted` are the upstream's
 * problem, not the user's, and `uncertain_submit` is ours (a crash between submit and
 * the remote id landing) — none of the three should ever count as one of their failures.
 */
describe("blameless failure codes stay out of the stop-loss count", () => {
  it("does not count a failed job whose error.code is rate_limited, quota_exhausted or uncertain_submit", () => {
    for (const code of ["rate_limited", "quota_exhausted", "uncertain_submit"]) {
      const jobs = [job({ status: "failed", error: { code } })];
      expect(usage(jobs, LAST_MS)).toMatchObject({ failures: 0 });
    }
  });

  it("applies the same exemption to a canceled job, not only a failed one", () => {
    const jobs = [job({ status: "canceled", error: { code: "uncertain_submit" } })];
    expect(usage(jobs, LAST_MS)).toMatchObject({ failures: 0 });
  });

  it("still counts a failure carrying any other error code", () => {
    const jobs = [job({ status: "failed", error: { code: "internal" } })];
    expect(usage(jobs, LAST_MS)).toMatchObject({ failures: 1 });
  });

  it("still counts a failure with no error field at all (records written before it existed)", () => {
    const jobs = [job({ status: "failed", error: undefined })];
    expect(usage(jobs, LAST_MS)).toMatchObject({ failures: 1 });
  });

  it("keeps the valve from tripping on 30 blameless failures, unlike 30 ordinary ones", () => {
    const blameless = Array.from({ length: 30 }, () => job({ status: "failed", error: { code: "rate_limited" } }));
    expect(quotaBlock(usage(blameless, LAST_MS))).toBeNull();

    const ordinary = Array.from({ length: 30 }, () => job({ status: "failed", error: { code: "internal" } }));
    expect(quotaBlock(usage(ordinary, LAST_MS))?.code).toBe("failure_limit_reached");
  });

  it("does not let a blameless code exempt an otherwise-consumed quota slot", () => {
    // Blameless-ness only affects the stop-loss valve; a rate-limited job still
    // occupies its reservation until it settles, and a succeeded one still counts as used.
    const jobs = [job({ status: "pending", error: null }), job({ status: "succeeded" })];
    expect(usage(jobs, LAST_MS)).toMatchObject({ used: 1, inFlight: 1, failures: 0 });
  });
});
