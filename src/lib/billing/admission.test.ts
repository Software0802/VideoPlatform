import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord, JobStatus } from "@/lib/jobs/schema";

/**
 * 余额准入（方案 §3.2）：`loadBalanceUsage` 现算 `balance − 在途预留`，
 * `assertBalance` 是唯一判官。口径与 `src/lib/jobs/quota-admission.test.ts` 的
 * 配额准入镜像——一个算「次」，一个算「元」。
 */

let dataRoot = "";
let loadBalanceUsage: typeof import("./admission").loadBalanceUsage;
let assertBalance: typeof import("./admission").assertBalance;
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let writeUser: typeof import("@/lib/users/store").writeUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-billing-admission-"));
  process.env.DATA_DIR = dataRoot;
  ({ loadBalanceUsage, assertBalance } = await import("./admission"));
  ({ writeJob } = await import("@/lib/jobs/store"));
  ({ writeUser } = await import("@/lib/users/store"));
});

afterEach(() => {
  delete process.env.LUMEN_ADMIN_USER_ID;
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
function job(ownerId: string | undefined, status: JobStatus, priceCny: number): JobRecord {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_admission_${seq}`,
    ownerId,
    status,
    progress: status === "succeeded" ? 100 : 0,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "余额准入测试",
    durationSec: 5,
    aspectRatio: "16:9",
    resolution: "720p",
    imageResolution: null,
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    priceCny,
    costUsdEstimate: 0.16,
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

describe("loadBalanceUsage", () => {
  it("reports the full balance available when there is nothing in flight", async () => {
    const id = userId("1");
    await seedUser(id, 100);
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, reservedCny: 0, availableCny: 100 });
  });

  it("reserves the price of every non-terminal job this user owns", async () => {
    const id = userId("2");
    await seedUser(id, 100);
    await writeJob(job(id, "pending", 30));
    await writeJob(job(id, "queued", 12));
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, reservedCny: 42, availableCny: 58 });
  });

  it("rounds a sum of reservations that would otherwise carry float noise", async () => {
    const id = userId("3");
    await seedUser(id, 10);
    await writeJob(job(id, "pending", 0.1));
    await writeJob(job(id, "pending", 0.1));
    await writeJob(job(id, "pending", 0.1));
    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in raw float arithmetic.
    expect((await loadBalanceUsage(id)).reservedCny).toBe(0.3);
  });

  it("does not reserve for a job that has already settled, whatever its terminal status", async () => {
    const id = userId("4");
    await seedUser(id, 100);
    for (const status of ["succeeded", "failed", "canceled", "expired"] as const) {
      await writeJob(job(id, status, 25));
    }
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, reservedCny: 0, availableCny: 100 });
  });

  it("does not reserve another user's in-flight job", async () => {
    const id = userId("5");
    const other = userId("6");
    await seedUser(id, 100);
    await seedUser(other, 100);
    await writeJob(job(other, "pending", 50));
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, reservedCny: 0, availableCny: 100 });
  });

  it("never reserves an ownerless legacy job — not even for the administrator", async () => {
    const admin = userId("7");
    await seedUser(admin, 100);
    process.env.LUMEN_ADMIN_USER_ID = admin;
    await writeJob(job(undefined, "pending", 40));
    expect(await loadBalanceUsage(admin)).toEqual({ balanceCny: 100, reservedCny: 0, availableCny: 100 });
  });

  it("treats a user with no user.json as a zero balance rather than throwing", async () => {
    const id = userId("8");
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 0, reservedCny: 0, availableCny: 0 });
  });
});

describe("assertBalance", () => {
  it("passes when available balance covers the price, including exactly", async () => {
    const id = userId("9");
    await seedUser(id, 5);
    await expect(assertBalance(id, 5)).resolves.toBeUndefined();
    await expect(assertBalance(id, 4.99)).resolves.toBeUndefined();
  });

  it("refuses with 402 insufficient_balance when available balance falls short", async () => {
    const id = userId("a");
    await seedUser(id, 5);
    await expect(assertBalance(id, 5.01)).rejects.toMatchObject({
      status: 402,
      code: "insufficient_balance",
    });
  });

  it("counts in-flight reservations against the available balance", async () => {
    const id = userId("b");
    await seedUser(id, 5);
    await writeJob(job(id, "pending", 4));
    // Only ¥1 left available; a further ¥2 submission must be refused.
    await expect(assertBalance(id, 2)).rejects.toMatchObject({ code: "insufficient_balance" });
    await expect(assertBalance(id, 1)).resolves.toBeUndefined();
  });
});
