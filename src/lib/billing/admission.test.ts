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
let purchasableCny: typeof import("./admission").purchasableCny;
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let writeUser: typeof import("@/lib/users/store").writeUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-billing-admission-"));
  process.env.DATA_DIR = dataRoot;
  ({ loadBalanceUsage, assertBalance, purchasableCny } = await import("./admission"));
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

const DAY_MS = 86_400_000;

/**
 * 有会员积分就顺手配一份**生效中**的订阅：会员池只在订阅有效期内算数，一个没有订阅
 * 撑着的池子在准入眼里等于零。要验「过期后不算数」的用例传负的 `expiresInDays`。
 */
async function seedUser(id: string, balanceCny: number, memberCreditsCny = 0, expiresInDays = 30) {
  const startedAt = new Date(Date.now() - DAY_MS).toISOString();
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    memberCreditsCny,
    ...(memberCreditsCny > 0
      ? {
          subscription: {
            id: "sub_00000000000000aa",
            planId: "standard" as const,
            cycle: "monthly" as const,
            startedAt,
            expiresAt: new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
            periodIndex: 0,
            periodStartedAt: startedAt,
          },
        }
      : {}),
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
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, memberCreditsCny: 0, effectiveMemberCny: 0, reservedCny: 0, availableCny: 100 });
  });

  it("reserves the price of every non-terminal job this user owns", async () => {
    const id = userId("2");
    await seedUser(id, 100);
    await writeJob(job(id, "pending", 30));
    await writeJob(job(id, "queued", 12));
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, memberCreditsCny: 0, effectiveMemberCny: 0, reservedCny: 42, availableCny: 58 });
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
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, memberCreditsCny: 0, effectiveMemberCny: 0, reservedCny: 0, availableCny: 100 });
  });

  it("does not reserve another user's in-flight job", async () => {
    const id = userId("5");
    const other = userId("6");
    await seedUser(id, 100);
    await seedUser(other, 100);
    await writeJob(job(other, "pending", 50));
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 100, memberCreditsCny: 0, effectiveMemberCny: 0, reservedCny: 0, availableCny: 100 });
  });

  it("never reserves an ownerless legacy job — not even for the administrator", async () => {
    const admin = userId("7");
    await seedUser(admin, 100);
    process.env.LUMEN_ADMIN_USER_ID = admin;
    await writeJob(job(undefined, "pending", 40));
    expect(await loadBalanceUsage(admin)).toEqual({ balanceCny: 100, memberCreditsCny: 0, effectiveMemberCny: 0, reservedCny: 0, availableCny: 100 });
  });

  it("counts the member credit pool as available money alongside the purchased balance", async () => {
    const id = userId("c");
    await seedUser(id, 4, 6);
    expect(await loadBalanceUsage(id)).toEqual({
      balanceCny: 4,
      memberCreditsCny: 6,
      effectiveMemberCny: 6,
      reservedCny: 0,
      availableCny: 10,
    });
  });

  it("subtracts in-flight reservations from the two pools combined, not from each", async () => {
    const id = userId("d");
    await seedUser(id, 4, 6);
    await writeJob(job(id, "pending", 7));
    // 7 元预留吃掉的是「两池之和」里的 7 元，而不是先把某一个池扣穿。
    expect((await loadBalanceUsage(id)).availableCny).toBe(3);
  });

  it("订阅过期后会员池不再计入 available，账面值照常报出来", async () => {
    const id = userId("f");
    // 昨天到期，但结算是惰性的：`user.json` 里 6 元会员积分还在。
    await seedUser(id, 4, 6, -1);
    expect(await loadBalanceUsage(id)).toEqual({
      balanceCny: 4,
      memberCreditsCny: 6,
      // 判定用的是这个 0，不是上面那个 6——两个数都摆出来，读数的人才看得出发生了什么。
      effectiveMemberCny: 0,
      reservedCny: 0,
      availableCny: 4,
    });
  });

  it("treats a user with no user.json as a zero balance rather than throwing", async () => {
    const id = userId("8");
    expect(await loadBalanceUsage(id)).toEqual({ balanceCny: 0, memberCreditsCny: 0, effectiveMemberCny: 0, reservedCny: 0, availableCny: 0 });
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

  it("admits a submission funded entirely by member credits", async () => {
    const id = userId("e");
    await seedUser(id, 0, 3);
    // R05：准入前先跑惰性结算——这个种子里缺本期积分入账行与当日日积分，第一次
    // assertBalance 会把它们都补上（会员池不再是账面的 3）。先触发一次再量边界：
    // 结算后的真实可花额刚刚好放行，多一分拒绝——全部来自会员池（已购池是 0）。
    await expect(assertBalance(id, 0.01)).resolves.toBeUndefined();
    const usage = await loadBalanceUsage(id);
    expect(usage.balanceCny).toBe(0);
    expect(usage.effectiveMemberCny).toBeGreaterThan(3);
    await expect(assertBalance(id, usage.effectiveMemberCny)).resolves.toBeUndefined();
    await expect(assertBalance(id, usage.effectiveMemberCny + 0.01)).rejects.toMatchObject({
      code: "insufficient_balance",
    });
  });

  it("订阅过期后那些会员积分一分钱都不能再花", async () => {
    const id = userId("f2");
    await seedUser(id, 0, 3, -1);
    await expect(assertBalance(id, 0.5)).rejects.toMatchObject({ code: "insufficient_balance" });
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

describe("purchasableCny", () => {
  /** `loadBalanceUsage` 的返回形状，只填这几个数就够算了。 */
  const usage = (balanceCny: number, effectiveMemberCny: number, reservedCny: number) => ({
    balanceCny,
    memberCreditsCny: effectiveMemberCny,
    effectiveMemberCny,
    reservedCny,
    availableCny: balanceCny + effectiveMemberCny - reservedCny,
  });

  it("没有在途任务时就是已购余额本身", () => {
    expect(purchasableCny(usage(50, 0, 0))).toBe(50);
    expect(purchasableCny(usage(50, 12, 0))).toBe(50);
  });

  it("在途预留先由有效会员积分顶，顶不住的那部分才从可购额里扣", () => {
    // 预留 10，会员积分 12 顶得住 → 已购池一分不占。
    expect(purchasableCny(usage(50, 12, 10))).toBe(50);
    // 预留 20，会员积分只顶得住 12，剩下 8 落在已购池上。
    expect(purchasableCny(usage(50, 12, 20))).toBe(42);
    // 没有会员积分时预留全部落在已购池上。
    expect(purchasableCny(usage(50, 0, 20))).toBe(30);
  });

  it("过期的会员积分顶不了预留（`effectiveMemberCny` 已经是 0 了）", () => {
    expect(purchasableCny({ ...usage(50, 0, 20), memberCreditsCny: 12 })).toBe(30);
  });

  it("预留吃穿已购池时如实报负数，不截成 0", () => {
    // 已购 5、预留 20、无会员积分 → 可购 −15。报负数是有意的：它说明这个账号已经
    // 超支了，把它截成 0 只会让「为什么买不了」变得更难解释。
    expect(purchasableCny(usage(5, 0, 20))).toBe(-15);
  });
});
