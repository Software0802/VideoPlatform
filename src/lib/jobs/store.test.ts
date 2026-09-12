import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "./schema";

/**
 * `store.updateJob` charges a job's `priceCny` exactly once when it reaches `succeeded`
 * (方案 §3.2) — the billing twin of the `completedAt` stamping covered in
 * `quota-admission.test.ts`. The runner is mocked out so nothing pumps these fixtures on
 * its own; every transition here is driven by hand.
 *
 * The deduction happens *before* the record is written, so that admission never sees a
 * window where the job is terminal (reservation gone) but the money has not left. What
 * keeps that from double-charging is `applyBalanceChange`'s per-jobId idempotency, not
 * the terminal edge — which is why the retry-after-failure case below can charge a job
 * that is already terminal.
 */
vi.mock("@/lib/jobs/runner", () => ({ enqueue: vi.fn(), activeCount: async () => 0 }));

let dataRoot = "";
let writeJob: typeof import("./store").writeJob;
let readJob: typeof import("./store").readJob;
let updateJob: typeof import("./store").updateJob;
let readUser: typeof import("@/lib/users/store").readUser;
let writeUser: typeof import("@/lib/users/store").writeUser;
let hasChargeFor: typeof import("@/lib/billing/ledger").hasChargeFor;
let readNotifications: typeof import("@/lib/notifications/store").readNotifications;
let notificationsDir: typeof import("@/lib/notifications/store").notificationsDir;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-store-charge-"));
  process.env.DATA_DIR = dataRoot;
  ({ writeJob, readJob, updateJob } = await import("./store"));
  ({ readUser, writeUser } = await import("@/lib/users/store"));
  ({ hasChargeFor } = await import("@/lib/billing/ledger"));
  ({ readNotifications, notificationsDir } = await import("@/lib/notifications/store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

async function seedUser(id: string, balanceCny: number) {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

let seq = 0;
function imageJob(ownerId: string | undefined, priceCny: number): JobRecord {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_store_charge_${seq}`,
    ownerId,
    status: "pending",
    progress: 50,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt: "扣款测试",
    durationSec: 0,
    aspectRatio: "16:9",
    resolution: null,
    imageResolution: "1k",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    priceCny,
    costUsdEstimate: 0.02,
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

describe("updateJob charges a succeeded job exactly once", () => {
  it("deducts priceCny from the owner's balance exactly once, and stamps billing.chargedAt", async () => {
    const id = userId("1");
    await seedUser(id, 100);
    const job = await writeJob(imageJob(id, 0.5));

    const succeeded = await updateJob(job.id, (r) => {
      r.status = "succeeded";
      r.output = { kind: "image", imageUrl: `/api/media/${job.id}/image.jpg` };
      return r;
    });
    expect(succeeded.billing?.chargedAt).toEqual(expect.any(String));
    expect((await readUser(id))?.balanceCny).toBe(99.5);

    // Idempotent: a later write on the already-terminal job (a cost correction, an
    // artifact sweep) must not charge a second time, mirroring `stampCompletedAt`.
    const chargedAt = succeeded.billing?.chargedAt;
    const again = await updateJob(job.id, (r) => {
      r.costUsdActual = 0.03;
      return r;
    });
    expect(again.billing?.chargedAt).toBe(chargedAt);
    expect((await readUser(id))?.balanceCny).toBe(99.5);
  });

  it("does not charge a job that transitions to failed", async () => {
    const id = userId("2");
    await seedUser(id, 100);
    const job = await writeJob(imageJob(id, 0.5));

    const failed = await updateJob(job.id, (r) => {
      r.status = "failed";
      r.error = { code: "internal", message: "上游炸了" };
      return r;
    });
    expect(failed.billing?.chargedAt).toBeUndefined();
    expect((await readUser(id))?.balanceCny).toBe(100);
  });

  it("does not charge a job that transitions to canceled", async () => {
    const id = userId("3");
    await seedUser(id, 100);
    const job = await writeJob(imageJob(id, 0.5));

    await updateJob(job.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      return r;
    });
    expect((await readUser(id))?.balanceCny).toBe(100);
  });

  it("leaves the balance untouched for a free (priceCny 0) job that succeeds", async () => {
    const id = userId("4");
    await seedUser(id, 100);
    const job = await writeJob(imageJob(id, 0));

    await updateJob(job.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    expect((await readUser(id))?.balanceCny).toBe(100);
  });

  it("does not throw for an ownerless legacy job succeeding, even with a positive priceCny", async () => {
    // Pre-user-system jobs have no ownerId (see `canAccessJob`); the charge path must
    // recognize that and skip rather than try to bill a user id that does not exist.
    const job = await writeJob(imageJob(undefined, 0.5));

    await expect(
      updateJob(job.id, (r) => {
        r.status = "succeeded";
        return r;
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("replays a charge without taking the money twice when the write was lost after it", async () => {
    // The crash window the charge-then-write ordering deliberately accepts: the money is
    // gone but job.json still says `pending`, so recovery pushes the job to `succeeded`
    // again and re-enters the charge path. `applyBalanceChange` sees its own ledger row
    // for this jobId and no-ops, so the balance moves once for the two transitions.
    const id = userId("5");
    await seedUser(id, 100);
    const job = await writeJob(imageJob(id, 0.5));

    await updateJob(job.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    expect((await readUser(id))?.balanceCny).toBe(99.5);
    expect(await hasChargeFor(id, job.id)).toBe(true);

    // Rewind the on-disk record to what it was just before the (lost) write: still
    // in flight, no chargedAt, while the deduction has already landed.
    const crashed = (await readJob(job.id))!;
    crashed.status = "pending";
    delete crashed.billing;
    delete crashed.completedAt;
    await writeJob(crashed);

    const recovered = await updateJob(job.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    expect(recovered.billing?.chargedAt).toEqual(expect.any(String));
    expect((await readUser(id))?.balanceCny).toBe(99.5);
  });

  it("still writes the terminal record when the charge throws, then settles it on the next update", async () => {
    // The owner's user.json does not exist yet, so `applyBalanceChange` throws. A job
    // that produced footage must not be held hostage to that: the record goes terminal
    // regardless, just without `chargedAt` — which is the marker the retry keys on.
    const id = userId("6");
    const job = await writeJob(imageJob(id, 0.5));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const failed = await updateJob(job.id, (r) => {
      r.status = "succeeded";
      r.output = { kind: "image", imageUrl: `/api/media/${job.id}/image.jpg` };
      return r;
    });
    expect(failed.status).toBe("succeeded");
    expect(failed.billing?.chargedAt).toBeUndefined();
    // Persisted, not just returned — a reader of job.json sees the finished job.
    const onDisk = await readJob(job.id);
    expect(onDisk?.status).toBe("succeeded");
    expect(onDisk?.billing?.chargedAt).toBeUndefined();
    expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).toContain(job.id);
    errors.mockRestore();

    // The account shows up (restored from backup, created late — the cause does not
    // matter); any later write on the job re-attempts the deduction. Note the job is
    // *already terminal* here, which is exactly why `pendingCharge` ignores the edge.
    await seedUser(id, 100);
    const settled = await updateJob(job.id, (r) => {
      r.costUsdActual = 0.02;
      return r;
    });
    expect(settled.billing?.chargedAt).toEqual(expect.any(String));
    expect((await readUser(id))?.balanceCny).toBe(99.5);
  });
});

/**
 * H1：终态通知落盘挂在 `updateJob` 的「非终态 → 终态」边沿上（方案 §2.2）——
 * 全仓唯一的终态入口，所以一条任务的同一次完成只产生一条通知。
 */
describe("updateJob appends a terminal notification exactly once", () => {
  it("writes one item on the edge and nothing on later already-terminal writes", async () => {
    const id = userId("7");
    await seedUser(id, 100);
    const job = await writeJob(imageJob(id, 0));

    await updateJob(job.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    let file = await readNotifications(id);
    expect(file?.items).toHaveLength(1);
    expect(file?.items[0]).toMatchObject({
      id: `${job.id}:succeeded`,
      jobId: job.id,
      status: "succeeded",
      kind: "job",
    });

    // 已终态任务上的后续写（成本回填、产物清理）不再构成边沿。
    await updateJob(job.id, (r) => {
      r.costUsdActual = 0.02;
      return r;
    });
    file = await readNotifications(id);
    expect(file?.items).toHaveLength(1);

    // 崩溃恢复把「非终态 → 同一终态」重推一遍：边沿会再走一次，但
    // `${jobId}:${status}` 幂等键让它仍是一条。
    const crashed = (await readJob(job.id))!;
    crashed.status = "pending";
    delete crashed.completedAt;
    await writeJob(crashed);
    await updateJob(job.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    file = await readNotifications(id);
    expect(file?.items).toHaveLength(1);
  });

  it("does not write a notification file for ownerless legacy jobs", async () => {
    const job = await writeJob(imageJob(undefined, 0));
    const before = await readdir(notificationsDir()).catch(() => [] as string[]);
    await updateJob(job.id, (r) => {
      r.status = "succeeded";
      return r;
    });
    const after = await readdir(notificationsDir()).catch(() => [] as string[]);
    expect(after.slice().sort()).toEqual(before.slice().sort());
  });
});
