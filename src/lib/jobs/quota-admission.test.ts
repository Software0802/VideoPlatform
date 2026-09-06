import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord, JobStatus } from "./schema";

/**
 * Admission side of the daily quota (plan §6.2): the judgement and the
 * `job.json` write share one `withAdmissionLock` critical section, and create /
 * retry go through the same judge.
 *
 * The runner is mocked out the way `retry-guard.test.ts` does it: a live pump
 * would settle the jobs these tests deliberately leave in flight, and would
 * make the counts depend on generation timing.
 */
vi.mock("@/lib/jobs/runner", () => ({ enqueue: vi.fn(), activeCount: async () => 0 }));

/**
 * 余额是另一条闸门（方案 §3.2），有自己的测试；这里放行它，否则每个测试的一次性
 * owner 都得先建一个有钱的账号，配额本身反而被埋掉。与上面的 runner mock 同一个理由：
 * 只留下这个文件真正要考的那条判定。
 */
vi.mock("@/lib/billing/admission", () => ({
  assertBalance: async () => {},
  loadBalanceUsage: async () => ({ balanceCny: 0, reservedCny: 0, availableCny: 0 }),
}));

const SESSION_SECRET = "quota-admission-test-secret-0123456789";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let retryJob: typeof import("./create").retryJob;
let writeJob: typeof import("./store").writeJob;
let updateJob: typeof import("./store").updateJob;
let readJob: typeof import("./store").readJob;
let loadQuotaUsage: typeof import("./quota").loadQuotaUsage;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-quota-admission-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  // 余额成为主闸门后配额的默认值抬到了 200（方案 §3.2），这些用例考的是配额的口径而不是
  // 那个数字，所以显式钉回 10，断言里的 11 次、剩 9 次才继续成立。
  process.env.FREE_DAILY_IMAGE_QUOTA = "10";
  delete process.env.FREE_DAILY_FAILURE_LIMIT;
  delete process.env.LUMEN_ADMIN_USER_ID;
  ({ createJob, retryJob } = await import("./create"));
  ({ writeJob, updateJob, readJob } = await import("./store"));
  ({ loadQuotaUsage } = await import("./quota"));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  delete process.env.LUMEN_SESSION_SECRET;
  delete process.env.FREE_DAILY_IMAGE_QUOTA;
  await rm(dataRoot, { recursive: true, force: true });
});

/** Distinct owner per test so one test's history cannot move another's counters. */
function owner(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

function imageRecord(ownerId: string | undefined, status: JobStatus): JobRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_${randomBytes(6).toString("hex")}`,
    ownerId,
    status,
    progress: status === "succeeded" ? 100 : 0,
    mode: "text_to_image",
    model: "grok-2-image",
    provider: "mock",
    prompt: "配额测试",
    durationSec: 0,
    aspectRatio: "16:9",
    resolution: null,
    imageResolution: "1k",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    priceCny: 0,
    costUsdEstimate: 0,
    costUsdActual: null,
    error: null,
    output: null,
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
  };
}

/** Seed history straight into `job.json`, which is the only thing quota counts. */
async function seed(ownerId: string | undefined, count: number, status: JobStatus): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  for (let i = 0; i < count; i += 1) out.push(await writeJob(imageRecord(ownerId, status)));
  return out;
}

function image(extra: Record<string, unknown> = {}) {
  return { mode: "text_to_image", prompt: "一张图", ...extra } as Parameters<typeof createJob>[0];
}

describe("daily image quota admission", () => {
  it("refuses the 11th submission of the day with 429 quota_exceeded", async () => {
    const id = owner("a1");
    await seed(id, 10, "succeeded");

    await expect(createJob(image(), id)).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
      message: "今日已用 10/10，北京时间 0 点重置",
    });
  });

  it("does not charge failed or canceled jobs, so the user can submit again", async () => {
    const id = owner("a2");
    await seed(id, 6, "failed");
    await seed(id, 6, "canceled");

    const { job } = await createJob(image(), id);
    expect(job.status).toBe("queued");
  });

  it("lets an in-flight job hold its slot", async () => {
    const id = owner("a3");
    await seed(id, 9, "succeeded");

    // The 10th is admitted and stays queued — it is the reservation.
    await createJob(image(), id);
    await expect(createJob(image(), id)).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("admits exactly one of five concurrent submissions for the last slot", async () => {
    const id = owner("a4");
    await seed(id, 9, "succeeded");

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createJob(image(), id)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ status: 429, code: "quota_exceeded" });
    }
  });

  it("judges a retry with the same rule as a new submission", async () => {
    const full = owner("a5");
    const [source] = await seed(full, 1, "failed");
    await seed(full, 10, "succeeded");

    await expect(retryJob(source, full)).rejects.toMatchObject({
      status: 429,
      code: "quota_exceeded",
    });

    // Same call succeeds for a user who still has room, so the guard is the quota
    // and not something structural about retry.
    const spare = owner("a6");
    const [spareSource] = await seed(spare, 1, "failed");
    const retried = await retryJob(spareSource, spare);
    expect(retried.id).not.toBe(spareSource.id);
  });

  it("replays an idempotent submission at full quota instead of refusing it", async () => {
    const id = owner("a7");
    const key = "quota-replay-key";
    const first = await createJob(image({ idempotencyKey: key }), id);
    expect(first.replay).toBe(false);

    await seed(id, 10, "succeeded");
    // used(10) + inFlight(1) is already past the limit, so only the replay path
    // can answer here — a replay is not a new consumption (plan §6.2).
    const again = await createJob(image({ idempotencyKey: key }), id);
    expect(again.replay).toBe(true);
    expect(again.job.id).toBe(first.job.id);
  });

  it("stops new submissions once the daily failure limit is reached", async () => {
    const id = owner("a8");
    process.env.FREE_DAILY_FAILURE_LIMIT = "3";
    try {
      await seed(id, 2, "failed");
      // Under the limit the account still works, and failures cost no quota.
      await createJob(image(), id);

      await seed(id, 1, "canceled");
      const error = await createJob(image(), id).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 429, code: "failure_limit_reached" });
      expect((error as { message: string }).message).toContain("联系管理员");
      expect((error as { message: string }).message).not.toContain(id);
    } finally {
      delete process.env.FREE_DAILY_FAILURE_LIMIT;
    }
  });

  it("does not meter video jobs against the image quota", async () => {
    const id = owner("a9");
    await seed(id, 10, "succeeded");

    const { job } = await createJob(
      { mode: "text_to_video", prompt: "一段视频", durationSec: 6 } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.mode).toBe("text_to_video");
  });

  it("charges ownerless legacy jobs to nobody, not even the administrator", async () => {
    const admin = owner("aa");
    await seed(undefined, 10, "succeeded");
    process.env.LUMEN_ADMIN_USER_ID = admin;
    try {
      // The administrator can *see* those jobs (`canAccessJob`), but they belong
      // to no account's quota.
      const { job } = await createJob(image(), admin);
      expect(job.status).toBe("queued");
    } finally {
      delete process.env.LUMEN_ADMIN_USER_ID;
    }
  });
});

/**
 * Finding 1: terminal jobs used to be bucketed by `createdAt`. `completedAt` is
 * stamped in exactly one place — `store.updateJob` — so that no terminal path can
 * forget it, and never rewritten, so that a later write cannot move a job to
 * another day.
 */
describe("completedAt stamping", () => {
  /** 2026-09-06 00:05 Beijing. */
  const SETTLED = new Date("2026-09-05T16:05:00.000Z");
  /** A much later write: a cost correction, or batch five's artifact sweep. */
  const SWEPT = new Date("2026-09-20T03:00:00.000Z");

  it("stamps on the non-terminal → terminal edge and never rewrites it", async () => {
    const [rec] = await seed(owner("c1"), 1, "queued");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SETTLED);
    const done = await updateJob(rec!.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    expect(done.completedAt).toBe(SETTLED.toISOString());

    vi.setSystemTime(SWEPT);
    const swept = await updateJob(rec!.id, (r) => {
      r.costUsdActual = 0.2;
      return r;
    });
    // `updatedAt` moves, the settle day does not.
    expect(swept.updatedAt).toBe(SWEPT.toISOString());
    expect(swept.completedAt).toBe(SETTLED.toISOString());
    expect((await readJob(rec!.id))?.completedAt).toBe(SETTLED.toISOString());
  });

  it("leaves a job that is still running unstamped", async () => {
    const [rec] = await seed(owner("c2"), 1, "queued");
    for (const status of ["submitting", "pending", "persisting"] as const) {
      const next = await updateJob(rec!.id, (r) => {
        r.status = status;
        return r;
      });
      expect(next.completedAt).toBeUndefined();
    }
  });

  it("does not date a record that was already terminal before the field existed", async () => {
    // Writing to a legacy finished job must not stamp it with today; `quota` reads
    // `updatedAt` for these instead.
    const [rec] = await seed(owner("c3"), 1, "succeeded");
    expect(rec!.completedAt).toBeUndefined();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SWEPT);
    const swept = await updateJob(rec!.id, (r) => {
      r.progress = 100;
      return r;
    });
    expect(swept.completedAt).toBeUndefined();
  });

  it("makes a job that crossed midnight count on the day it finished", async () => {
    const id = owner("c4");
    const [rec] = await seed(id, 1, "pending");
    await updateJob(rec!.id, (r) => {
      // Submitted 2026-09-05 23:59 Beijing …
      r.createdAt = "2026-09-05T15:59:00.000Z";
      return r;
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    // … and finished six minutes later, which is already the next Beijing day.
    vi.setSystemTime(SETTLED);
    await updateJob(rec!.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    vi.useRealTimers();

    // The old `createdAt` rule counted it on neither day: a free image.
    const yesterday = await loadQuotaUsage(id, Date.parse("2026-09-05T15:59:59.999Z"));
    expect(yesterday).toMatchObject({ used: 0, inFlight: 0 });
    const today = await loadQuotaUsage(id, Date.parse("2026-09-05T16:10:00.000Z"));
    expect(today).toMatchObject({ used: 1, remaining: 9 });
  });

  it("makes a cross-midnight failure visible to the stop-loss valve", async () => {
    const id = owner("c5");
    const [rec] = await seed(id, 1, "pending");
    await updateJob(rec!.id, (r) => {
      r.createdAt = "2026-09-05T15:59:00.000Z";
      return r;
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SETTLED);
    await updateJob(rec!.id, (r) => {
      r.status = "failed";
      r.error = { code: "upstream_unavailable", message: "上游不可用" };
      return r;
    });
    vi.useRealTimers();

    const today = await loadQuotaUsage(id, Date.parse("2026-09-05T16:10:00.000Z"));
    // No quota consumed — but the valve can see it now.
    expect(today).toMatchObject({ used: 0, remaining: 10, failures: 1 });
  });
});

describe("GET /api/me quota", () => {
  it("reports limit, used, in-flight, remaining and the Beijing reset time", async () => {
    const { hashPassword } = await import("@/lib/users/password");
    const { resetUserIndexCache, writeUser } = await import("@/lib/users/store");
    const { SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session");
    const { GET } = await import("@/app/api/me/route");

    resetUserIndexCache();
    const user = await writeUser({
      id: owner("ab"),
      email: "quota@example.com",
      passwordHash: await hashPassword("password-1234"),
      sessionEpoch: 1,
      plan: "free",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await seed(user.id, 3, "succeeded");
    await seed(user.id, 1, "pending");
    await seed(user.id, 1, "failed");

    const response = await GET(
      new Request("http://localhost/api/me", {
        headers: { cookie: `${SESSION_COOKIE}=${issueSessionValue(user)}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      userId: string;
      quota: Record<string, unknown>;
    };

    expect(body.userId).toBe(user.id);
    expect(body.quota).toEqual({
      limit: 10,
      used: 3,
      inFlight: 1,
      remaining: 6,
      resetsAt: expect.any(String),
      blocked: null,
    });
    expect(Date.parse(body.quota.resetsAt as string)).toBeGreaterThan(Date.now());
  });

  /**
   * Finding 3: with 30 failures and nothing succeeded, `remaining` reads 10 while
   * every submission is refused. The route now carries the valve as well.
   */
  it("reports the stop-loss valve, with the same message the submission would be refused with", async () => {
    const { hashPassword } = await import("@/lib/users/password");
    const { resetUserIndexCache, writeUser } = await import("@/lib/users/store");
    const { SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session");
    const { GET } = await import("@/app/api/me/route");

    resetUserIndexCache();
    const user = await writeUser({
      id: owner("ac"),
      email: "stopped@example.com",
      passwordHash: await hashPassword("password-1234"),
      sessionEpoch: 1,
      plan: "free",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await seed(user.id, 30, "failed");

    const response = await GET(
      new Request("http://localhost/api/me", {
        headers: { cookie: `${SESSION_COOKIE}=${issueSessionValue(user)}` },
      }),
    );
    const body = (await response.json()) as { quota: Record<string, unknown> };

    // Failures consumed no quota, and the number still says so honestly …
    expect(body.quota).toMatchObject({ used: 0, inFlight: 0, remaining: 10 });
    // … but the client is now told why a submission would be refused anyway.
    expect(body.quota.blocked).toMatchObject({ code: "failure_limit_reached" });

    const refused = await createJob(image(), user.id).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "failure_limit_reached" });
    expect((body.quota.blocked as { message: string }).message).toBe(
      (refused as { message: string }).message,
    );
  });
});
