import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const SESSION_SECRET = "quota-admission-test-secret-0123456789";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let retryJob: typeof import("./create").retryJob;
let writeJob: typeof import("./store").writeJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-quota-admission-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  delete process.env.FREE_DAILY_IMAGE_QUOTA;
  delete process.env.FREE_DAILY_FAILURE_LIMIT;
  delete process.env.LUMEN_ADMIN_USER_ID;
  ({ createJob, retryJob } = await import("./create"));
  ({ writeJob } = await import("./store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  delete process.env.LUMEN_SESSION_SECRET;
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
    });
    expect(Date.parse(body.quota.resetsAt as string)).toBeGreaterThan(Date.now());
  });
});
