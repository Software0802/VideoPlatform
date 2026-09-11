import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord, JobStatus } from "@/lib/jobs/schema";

/**
 * 显式资金预留（A 包）：`reserveJobFunds` 在准入那一刻把分池分配额冻结成
 * `job.reservation`，之后维护一条不变量——**会员池账面 ≥ Σ 在途任务 earmark**。
 *
 * 守的是这几条线：
 *
 *  1. 准入按「会员优先」冻结分配：earmark = min(售价, 还可 earmark 的会员积分)；
 *  2. 结算扣款戴 `memberMaxCny` 上限——不许把别的在途任务 earmark 的钱花掉；
 *  3. 期次重置 / 到期清零先保住 earmark；任务进终态后 earmark 消失，
 *     下一次惰性结算把没被承诺的余额冲销；
 *  4. `memberMaxCny` 与 `pool` / `refundOf` / 正 delta 互斥。
 */

const DAY_MS = 86_400_000;

let dataRoot = "";
let reserveJobFunds: typeof import("./admission").reserveJobFunds;
let settleSubscription: typeof import("./subscription").settleSubscription;
let applyBalanceChange: typeof import("@/lib/billing/ledger").applyBalanceChange;
let readUser: typeof import("@/lib/users/store").readUser;
let writeUser: typeof import("@/lib/users/store").writeUser;
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let updateJob: typeof import("@/lib/jobs/store").updateJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-reservation-"));
  process.env.DATA_DIR = dataRoot;
  ({ reserveJobFunds } = await import("./admission"));
  ({ settleSubscription } = await import("./subscription"));
  ({ applyBalanceChange } = await import("@/lib/billing/ledger"));
  ({ readUser, writeUser } = await import("@/lib/users/store"));
  ({ writeJob, updateJob } = await import("@/lib/jobs/store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
}

/**
 * 配一份生效中的订阅。`cycle: "yearly"` 才能跨期（月付只有 1 期，永远滚不动
 * `periodIndex`）；`expiresInDays` 传负数造一份昨天就到期的订阅。
 */
async function seedUser(
  id: string,
  balanceCny: number,
  memberCreditsCny = 0,
  options: { cycle?: "monthly" | "yearly"; expiresInDays?: number; withSub?: boolean } = {},
) {
  const { cycle = "monthly", expiresInDays = 30, withSub = memberCreditsCny > 0 } = options;
  const startedAt = new Date(Date.now() - DAY_MS).toISOString();
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    memberCreditsCny,
    ...(withSub
      ? {
          subscription: {
            id: "sub_00000000000000aa",
            planId: "standard" as const,
            cycle,
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

function reservation(memberCny: number, purchasedCny: number): JobRecord["reservation"] {
  return {
    id: `res_${(seq + 1).toString(16).padStart(16, "0")}`,
    amountCny: memberCny + purchasedCny,
    memberCny,
    purchasedCny,
    subscriptionId: "sub_00000000000000aa",
    periodIndex: 0,
    createdAt: new Date().toISOString(),
  };
}

let seq = 0;
function job(ownerId: string, status: JobStatus, priceCny: number): JobRecord {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_res_${seq}`,
    ownerId,
    status,
    progress: status === "succeeded" ? 100 : 0,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "预留测试",
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

describe("reserveJobFunds", () => {
  it("准入把售价冻结成分池分配：会员池先顶，余下落在已购池", async () => {
    const id = userId("res-alloc");
    await seedUser(id, 100, 8);
    const res = await reserveJobFunds(id, 5);
    expect(res).toMatchObject({ amountCny: 5, memberCny: 5, purchasedCny: 0 });
    expect(res?.id).toMatch(/^res_[0-9a-f]{16}$/);
    expect(res?.subscriptionId).toBe("sub_00000000000000aa");
    expect(res?.periodIndex).toBe(0);
  });

  it("可 earmark 的会员积分不够时，其余落到已购池承诺额", async () => {
    const id = userId("res-split");
    // 订阅生效中、会员池从 0 起：第一次结算发下本期 ¥12 + 当日 ¥0.6。
    await seedUser(id, 100, 0, { withSub: true });
    await settleSubscription(id);
    // 先钉走 10 元 earmark，spendable 只剩 2.6：新任务的 5 元只能 2.6 / 2.4 分池。
    const held = job(id, "pending", 10);
    held.reservation = reservation(10, 0);
    await writeJob(held);
    const res = await reserveJobFunds(id, 5);
    expect(res).toMatchObject({ amountCny: 5, memberCny: 2.6, purchasedCny: 2.4 });
  });

  it("没有订阅时不 earmark：全部承诺由已购池出", async () => {
    const id = userId("res-nosub");
    await seedUser(id, 100);
    const res = await reserveJobFunds(id, 5);
    expect(res).toMatchObject({ amountCny: 5, memberCny: 0, purchasedCny: 5 });
    expect(res?.subscriptionId).toBeUndefined();
  });

  it("余额不够照样 402，不产生预留", async () => {
    const id = userId("res-poor");
    await seedUser(id, 2);
    await expect(reserveJobFunds(id, 5)).rejects.toMatchObject({
      status: 402,
      code: "insufficient_balance",
    });
  });

  it("零价任务不产生预留对象", async () => {
    const id = userId("res-free");
    await seedUser(id, 0);
    await expect(reserveJobFunds(id, 0)).resolves.toBeUndefined();
  });
});

describe("memberMaxCny 结算上限", () => {
  it("任务成功时按 earmark 封顶会员份额，不吃掉池里多出来的钱", async () => {
    const id = userId("res-cap");
    await seedUser(id, 100, 8);
    const j = job(id, "pending", 5);
    j.reservation = {
      id: "res_00000000000000b1",
      amountCny: 5,
      memberCny: 3,
      purchasedCny: 2,
      subscriptionId: "sub_00000000000000aa",
      periodIndex: 0,
      createdAt: new Date().toISOString(),
    };
    await writeJob(j);
    await updateJob(j.id, (r) => ({ ...r, status: "succeeded" as const, progress: 100 }));
    const user = await readUser(id);
    // 池里有 8 元会员积分，但 earmark 只有 3：会员 −3，已购 −2。
    expect(user?.memberCreditsCny).toBe(5);
    expect(user?.balanceCny).toBe(98);
  });

  it("没有预留对象的老任务沿用会员池优先的旧语义", async () => {
    const id = userId("res-legacy");
    await seedUser(id, 100, 8);
    const j = job(id, "pending", 5);
    await writeJob(j);
    await updateJob(j.id, (r) => ({ ...r, status: "succeeded" as const, progress: 100 }));
    const user = await readUser(id);
    expect(user?.memberCreditsCny).toBe(3);
    expect(user?.balanceCny).toBe(100);
  });
});

describe("跨期 earmark 不变量", () => {
  it("期次重置先保住 earmark：在途任务的承诺不随清零作废", async () => {
    const id = userId("res-keep");
    // 年付 12 期才能跨期：期边界在 +29d（种子 startedAt = 昨天）。
    await seedUser(id, 100, 8, { cycle: "yearly", expiresInDays: 360 });
    const j = job(id, "pending", 5);
    j.reservation = reservation(5, 0);
    await writeJob(j);

    // 跨到下一期（+29.5d：过了第 0 期终点、还在订阅有效期内）：
    // 8 元旧积分本应清零，但 5 元 earmark 保住；本期积分 ¥12 + 当日 ¥0.6 照常发。
    const user = await settleSubscription(id, new Date(Date.now() + 29.5 * DAY_MS));
    expect(user?.subscription?.periodIndex).toBe(1);
    expect(user?.memberCreditsCny).toBe(5 + 12 + 0.6);

    // 任务结算时仍按承诺从会员池出钱（earmark 跨期仍有效）。
    await updateJob(j.id, (r) => ({ ...r, status: "succeeded" as const, progress: 100 }));
    const charged = await readUser(id);
    expect(charged?.memberCreditsCny).toBe(12.6);
    expect(charged?.balanceCny).toBe(100);
  });

  it("任务进终态后 earmark 消失：下一次结算把没被承诺的余额冲销", async () => {
    const id = userId("res-free-pool");
    await seedUser(id, 100, 8, { cycle: "yearly", expiresInDays: 360 });
    const j = job(id, "pending", 5);
    j.reservation = reservation(5, 0);
    await writeJob(j);
    // 跨期保住 earmark（8 → 5 + 12 + 0.6 = 17.6），任务随后失败：
    // earmark 属于已过的第 0 期，进终态时写一行冲销把它清出池子。
    await settleSubscription(id, new Date(Date.now() + 29.5 * DAY_MS));
    await updateJob(j.id, (r) => ({ ...r, status: "failed" as const }));
    expect((await readUser(id))?.memberCreditsCny).toBe(12.6);
    // 再往后一天结算：冲销过的 earmark 不复活，只多一天日积分。
    const user = await settleSubscription(id, new Date(Date.now() + 30.5 * DAY_MS));
    expect(user?.memberCreditsCny).toBe(13.2);
    expect(user?.subscription?.periodIndex).toBe(1);
  });

  it("当期 earmark 失败即溶解回可花池：不写冲销行、不动余额", async () => {
    const id = userId("res-dissolve");
    await seedUser(id, 100, 8);
    const j = job(id, "pending", 5);
    j.reservation = reservation(5, 0);
    await writeJob(j);
    await updateJob(j.id, (r) => ({ ...r, status: "failed" as const }));
    // 钱本来就是当期有效积分，任务失败后回到可花口径，池子一分不动。
    const user = await readUser(id);
    expect(user?.memberCreditsCny).toBe(8);
    const released = (await import("@/lib/jobs/store")).readJob;
    expect((await released(j.id))?.reservation?.releasedAt).toBeTruthy();
  });
});

describe("memberMaxCny 输入约束", () => {
  it("与 pool / refundOf / 正 delta 互斥", async () => {
    const id = userId("res-cap-rules");
    await seedUser(id, 100, 8);
    await expect(
      applyBalanceChange(id, -5, { kind: "charge", amountCny: -5 }, { memberMaxCny: 3, pool: "member" }),
    ).rejects.toMatchObject({ code: "billing_invalid_member_cap" });
    await expect(
      applyBalanceChange(id, 5, { kind: "grant", amountCny: 5 }, { memberMaxCny: 3 }),
    ).rejects.toMatchObject({ code: "billing_invalid_member_cap" });
  });

  it("同 jobId 重放带着同样的上限：幂等语义不变", async () => {
    const id = userId("res-cap-replay");
    await seedUser(id, 100, 8);
    const entry = { kind: "charge" as const, amountCny: -5, jobId: "job_res_replay" };
    await applyBalanceChange(id, -5, entry, { memberMaxCny: 3 });
    const again = await applyBalanceChange(id, -5, entry, { memberMaxCny: 3 });
    expect(again.memberCreditsCny).toBe(5);
    expect(again.balanceCny).toBe(98);
    // 同键异参（换了上限）照样判冲突。
    await expect(
      applyBalanceChange(id, -5, entry, { memberMaxCny: 1 }),
    ).rejects.toMatchObject({ code: "billing_idempotency_conflict" });
  });
});
