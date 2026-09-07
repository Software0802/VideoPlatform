import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "@/lib/jobs/schema";

/**
 * 订阅的购买与惰性结算（方案 §3.2）。这份用例守的是四条不能破的线：
 *
 *  1. 订阅只花**已购池**——会员积分再多也买不了订阅（否则无限套利）；
 *  2. 会员池**期末清零**、跨期重置，不累积；
 *  3. 每日积分一天只发一次（结算是惰性的，一天会被触发几十次）；
 *  4. 每一步都按 `ref` 幂等，重放不重复入账 / 不重复扣款。
 *
 * 时间用 `settleSubscription(userId, now)` 的第二参注入，不靠等真实时钟。
 */

const DAY_MS = 86_400_000;

let dataRoot = "";
let purchaseSubscription: typeof import("./subscription").purchaseSubscription;
let settleSubscription: typeof import("./subscription").settleSubscription;
let publicSubscription: typeof import("./subscription").publicSubscription;
let shanghaiDay: typeof import("./subscription").shanghaiDay;
let applyBalanceChange: typeof import("@/lib/billing/ledger").applyBalanceChange;
let ledgerFilePath: typeof import("@/lib/billing/ledger").ledgerFilePath;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;
let writeJob: typeof import("@/lib/jobs/store").writeJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-subscription-test-"));
  process.env.DATA_DIR = dataRoot;
  // 价格随部署环境变（`costRatio`），把它钉成生产那台的配置，断言才能写死数字：
  // 标准档月费 ¥19.1、年费 ¥229.2。
  process.env.VIDEO_PROVIDER_ORDER = "kling,yman,grok";
  process.env.IMAGE_PROVIDER_ORDER = "openai,yman";
  process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({ high: { "1K": 0.2, "2K": 0.4 } });
  process.env.OPENAI_IMAGE_QUALITY = "high";
  ({ purchaseSubscription, settleSubscription, publicSubscription, shanghaiDay } = await import(
    "./subscription"
  ));
  ({ applyBalanceChange, ledgerFilePath } = await import("@/lib/billing/ledger"));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
  ({ writeJob } = await import("@/lib/jobs/store"));
});

afterAll(async () => {
  for (const key of [
    "DATA_DIR",
    "VIDEO_PROVIDER_ORDER",
    "IMAGE_PROVIDER_ORDER",
    "OPENAI_IMAGE_PRICE_TABLE",
    "OPENAI_IMAGE_QUALITY",
  ]) {
    delete process.env[key];
  }
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
}

async function seedUser(id: string, balanceCny: number, memberCreditsCny = 0) {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    memberCreditsCny,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

let keySeq = 0;
/**
 * 买一份订阅。`idempotencyKey` 默认每次新发一个（= 用户每次点「确认订阅」都是一次
 * 独立的购买）；要验重放的用例自己传同一个 key 进来。
 */
async function buy(
  id: string,
  planId: "standard" | "pro" | "premium" | "ultimate",
  cycle: "monthly" | "yearly",
  key?: string,
) {
  keySeq += 1;
  return purchaseSubscription(id, planId, cycle, key ?? `idem-${keySeq}`);
}

async function ledgerLines(id: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(ledgerFilePath(id), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 标准档：月费 ¥19.1、一期会员积分 ¥12（1200 积分）、日积分 ¥0.6（60 积分）。 */
const STANDARD_MONTHLY = 19.1;
const STANDARD_PERIOD_CNY = 12;
const DAILY_CNY = 0.6;

describe("purchaseSubscription", () => {
  it("从已购池扣款、写订阅、把会员池置为本期积分", async () => {
    const id = userId("buy1");
    await seedUser(id, 100);

    const result = await buy(id, "standard", "monthly");
    expect(result.paidCny).toBe(STANDARD_MONTHLY);

    const user = await readUser(id);
    expect(user?.balanceCny).toBe(100 - STANDARD_MONTHLY);
    expect(user?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY);
    expect(user?.subscription?.planId).toBe("standard");
    expect(user?.subscription?.cycle).toBe("monthly");
    expect(user?.subscription?.periodIndex).toBe(0);
    // 月付 = 一期 30 天。
    const span = Date.parse(user!.subscription!.expiresAt) - Date.parse(user!.subscription!.startedAt);
    expect(span).toBe(30 * DAY_MS);

    const lines = await ledgerLines(id);
    const charge = lines.find((l) => l.kind === "charge");
    // 扣款行只动已购池：没有 memberCny，balanceAfterCny 就是扣完的已购余额。
    expect(charge).toMatchObject({ amountCny: -STANDARD_MONTHLY, balanceAfterCny: 80.9 });
    expect(charge).not.toHaveProperty("memberCny");
    const grant = lines.find((l) => l.kind === "grant");
    // 会员池入账不改已购池，所以 balanceAfterCny 停在扣款后的那个数。
    expect(grant).toMatchObject({ amountCny: STANDARD_PERIOD_CNY, balanceAfterCny: 80.9 });
  });

  it("年付 = 12 期，扣 12 × 月费，会员池仍然只发第一期", async () => {
    const id = userId("buy2");
    await seedUser(id, 500);
    const result = await buy(id, "standard", "yearly");
    // 229.2 而不是 229.19999999999999：年费是 `planPrices` 里 round2 过的数。
    expect(result.paidCny).toBe(229.2);
    const user = await readUser(id);
    expect(user?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY);
    const span = Date.parse(user!.subscription!.expiresAt) - Date.parse(user!.subscription!.startedAt);
    expect(span).toBe(360 * DAY_MS);
  });

  it("已购池不够就 402，并说清还差多少、现在有多少", async () => {
    const id = userId("buy3");
    await seedUser(id, 3);
    await expect(buy(id, "standard", "monthly")).rejects.toMatchObject({
      status: 402,
      code: "insufficient_balance",
      needCny: STANDARD_MONTHLY,
      purchasableCny: 3,
    });
    expect((await readUser(id))?.subscription).toBeUndefined();
    expect(await ledgerLines(id)).toHaveLength(0);
  });

  it("会员积分买不了订阅：两池加起来 103 元，判定只认已购池的 3 元", async () => {
    const id = userId("buy4");
    await seedUser(id, 3, 100);
    // 这是整套设计的地基：会员积分能买订阅的话，「买 → 得积分 → 再买」就是无限套利。
    // 回执里报的可购额是 3（已购池）而不是 103，用户看到的数与判据是同一个。
    await expect(buy(id, "standard", "monthly")).rejects.toMatchObject({
      status: 402,
      code: "insufficient_balance",
      purchasableCny: 3,
    });
    expect((await readUser(id))?.subscription).toBeUndefined();
    expect((await ledgerLines(id)).some((l) => l.kind === "charge")).toBe(false);
    // 顺带证明另一条：会员积分脱离订阅就没有存在的理由，购买前的那次结算把它扫掉了
    // （这个状态只可能来自崩在到期清零半路，或手工改过记录）。
    expect((await readUser(id))?.memberCreditsCny).toBe(0);
  });

  it("已有生效订阅时 409，不扣第二笔钱", async () => {
    const id = userId("buy5");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const before = (await readUser(id))?.balanceCny;
    await expect(buy(id, "pro", "monthly")).rejects.toMatchObject({
      status: 409,
      code: "subscription_active",
    });
    expect((await readUser(id))?.balanceCny).toBe(before);
  });
});

describe("settleSubscription 每日积分", () => {
  it("同一天结算多少次都只发一次", async () => {
    const id = userId("day1");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const now = new Date();

    await settleSubscription(id, now);
    await settleSubscription(id, now);
    await settleSubscription(id, now);

    const user = await readUser(id);
    expect(user?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
    expect(user?.subscription?.lastDailyGrantOn).toBe(shanghaiDay(now));
    const daily = (await ledgerLines(id)).filter((l) => String(l.ref ?? "").includes(":d"));
    expect(daily).toHaveLength(1);
  });

  it("第二天再发一次，`ref` 带日期所以两天两行", async () => {
    const id = userId("day2");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const now = new Date();
    await settleSubscription(id, now);
    await settleSubscription(id, new Date(now.getTime() + DAY_MS));
    expect((await readUser(id))?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + 2 * DAILY_CNY);
    const daily = (await ledgerLines(id)).filter((l) => String(l.ref ?? "").includes(":d"));
    expect(daily).toHaveLength(2);
  });
});

describe("settleSubscription 跨期与到期", () => {
  it("跨到下一期：上期没用完的会员积分清零，重置为本期额度", async () => {
    const id = userId("per1");
    await seedUser(id, 500);
    await buy(id, "standard", "yearly");
    // 花掉一半会员积分（任务扣款默认先扣会员池）
    await applyBalanceChange(id, -5, { kind: "charge", amountCny: -5, jobId: "job_period" });
    expect((await readUser(id))?.memberCreditsCny).toBe(7);

    const now = new Date();
    const settled = await settleSubscription(id, new Date(now.getTime() + 31 * DAY_MS));
    // 未用完的 7 元不结转：重置成本期的 12 元，再加当天的日积分。
    expect(settled?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
    expect(settled?.subscription?.periodIndex).toBe(1);

    const rows = await ledgerLines(id);
    expect(rows.some((l) => String(l.ref ?? "").endsWith(":p1:reset") && l.memberCny === 7)).toBe(true);
    expect(rows.some((l) => String(l.ref ?? "").endsWith(":p1") && l.amountCny === 12)).toBe(true);
  });

  it("跨期结算重放不重复入账", async () => {
    const id = userId("per2");
    await seedUser(id, 500);
    await buy(id, "standard", "yearly");
    const at = new Date(Date.now() + 31 * DAY_MS);
    await settleSubscription(id, at);
    await settleSubscription(id, at);
    await settleSubscription(id, at);
    expect((await readUser(id))?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
    const rows = await ledgerLines(id);
    expect(rows.filter((l) => String(l.ref ?? "").endsWith(":p1"))).toHaveLength(1);
  });

  it("一次跨好几期（离线 90 天）也只重置一次，落在正确的期号上", async () => {
    const id = userId("per3");
    await seedUser(id, 500);
    await buy(id, "standard", "yearly");
    const settled = await settleSubscription(id, new Date(Date.now() + 91 * DAY_MS));
    expect(settled?.subscription?.periodIndex).toBe(3);
    expect(settled?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
    const rows = await ledgerLines(id);
    expect(rows.filter((l) => l.kind === "grant" && String(l.ref ?? "").includes(":p"))).toHaveLength(2);
  });

  it("到期：会员积分清零，订阅记录删掉，已购余额一分不动", async () => {
    const id = userId("exp1");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const balanceBefore = (await readUser(id))?.balanceCny;

    const settled = await settleSubscription(id, new Date(Date.now() + 31 * DAY_MS));
    expect(settled?.subscription).toBeUndefined();
    expect(settled?.memberCreditsCny).toBe(0);
    expect(settled?.balanceCny).toBe(balanceBefore);
    expect(publicSubscription(settled)).toBeNull();
    const rows = await ledgerLines(id);
    expect(rows.some((l) => String(l.ref ?? "").endsWith(":end") && l.memberCny === 12)).toBe(true);
  });

  it("到期后可以再买一份，新订阅从第 0 期重新开始", async () => {
    const id = userId("exp2");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    await settleSubscription(id, new Date(Date.now() + 31 * DAY_MS));
    const again = await buy(id, "standard", "monthly");
    expect(again.subscription.periodIndex).toBe(0);
    expect((await readUser(id))?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY);
  });

  it("没有订阅却留着会员积分（半路崩过 / 手工改过）时扫地出门", async () => {
    const id = userId("orph");
    await seedUser(id, 10, 8);
    const settled = await settleSubscription(id);
    expect(settled?.memberCreditsCny).toBe(0);
    expect(settled?.balanceCny).toBe(10);
  });

  it("账号不存在时返回 null 而不是抛错", async () => {
    expect(await settleSubscription(userId("nope"))).toBeNull();
  });
});

describe("publicSubscription", () => {
  it("把会员池余量与「今天发过没有」一起摆出来", async () => {
    const id = userId("pub1");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const now = new Date();
    const settled = await settleSubscription(id, now);
    const mine = publicSubscription(settled, now);
    expect(mine).toMatchObject({
      planId: "standard",
      cycle: "monthly",
      periodIndex: 0,
      memberCreditsCny: STANDARD_PERIOD_CNY + DAILY_CNY,
      dailyGrantedToday: true,
    });
    expect(mine?.id.startsWith("sub_")).toBe(true);
  });

  it("没订阅就是 null", () => {
    expect(publicSubscription(null)).toBeNull();
  });
});

describe("purchaseSubscription 幂等", () => {
  it("同一个 idempotencyKey 再来一次拿回同一份订阅（200 而不是 409），只扣一笔钱", async () => {
    const id = userId("idem1");
    await seedUser(id, 100);
    const first = await buy(id, "standard", "monthly", "key-same");
    expect(first.replay).toBe(false);

    const again = await buy(id, "standard", "monthly", "key-same");
    expect(again.replay).toBe(true);
    expect(again.subscription.id).toBe(first.subscription.id);
    expect(again.paidCny).toBe(STANDARD_MONTHLY);

    // 钱只扣了一次，本期会员积分也只发了一份（第二次调用顺手做了当天的日积分结算，
    // 所以池子里多出 ¥0.6——那是每日赠送，不是重复的本期额度）。
    expect((await readUser(id))?.balanceCny).toBe(100 - STANDARD_MONTHLY);
    expect((await readUser(id))?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
    const rows = await ledgerLines(id);
    expect(rows.filter((l) => l.kind === "charge")).toHaveLength(1);
    expect(rows.filter((l) => l.ref === `sub:${first.subscription.id}:p0`)).toHaveLength(1);
  });

  it("换一个 key 就是另一次购买，照旧被 409 挡住", async () => {
    const id = userId("idem2");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly", "key-a");
    await expect(buy(id, "pro", "monthly", "key-b")).rejects.toMatchObject({
      status: 409,
      code: "subscription_active",
    });
  });

  it("扣款成功、写订阅之前崩掉：同 key 重试补上订阅，但不会扣第二笔钱", async () => {
    const id = userId("idem3");
    await seedUser(id, 100);
    // 模拟那个崩溃窗口：流水里已经有这笔扣款，`user.json` 里却没有订阅。
    await applyBalanceChange(
      id,
      -STANDARD_MONTHLY,
      { kind: "charge", amountCny: -STANDARD_MONTHLY, ref: "sub:key-crash", note: "订阅 标准版（月付）" },
      { pool: "purchased" },
    );
    expect((await readUser(id))?.subscription).toBeUndefined();

    const result = await buy(id, "standard", "monthly", "key-crash");
    expect(result.replay).toBe(false);
    expect((await readUser(id))?.subscription?.planId).toBe("standard");
    // 关键：余额只被扣过一次（`applyBalanceChangeLocked` 按 ref 去重）。
    expect((await readUser(id))?.balanceCny).toBe(100 - STANDARD_MONTHLY);
    expect((await ledgerLines(id)).filter((l) => l.kind === "charge")).toHaveLength(1);
  });

  it("一个用过、订阅已到期的 key 不能白换一份新订阅", async () => {
    const id = userId("idem4");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly", "key-old");
    await settleSubscription(id, new Date(Date.now() + 31 * DAY_MS));
    expect((await readUser(id))?.subscription).toBeUndefined();
    // 这个 key 的扣款行还在流水里，本期入账行（`sub:<id>:p0`）也在——后者正是「订阅真的
    // 建成过」的痕迹。放行的话扣款会被幂等跳过 = 白送一份订阅。
    await expect(buy(id, "standard", "monthly", "key-old")).rejects.toMatchObject({
      status: 400,
      code: "idempotency_key_reused",
    });
    expect((await readUser(id))?.subscription).toBeUndefined();
  });

  it("订阅 id 由 key 推导，所以重试写的是同一份记录", async () => {
    const id = userId("idem5");
    await seedUser(id, 100);
    const { subscription } = await buy(id, "standard", "monthly", "key-derive");
    const { subscriptionIdFor } = await import("./subscription");
    expect(subscription.id).toBe(subscriptionIdFor("key-derive"));
    expect(subscription.id).toMatch(/^sub_[0-9a-f]{16}$/);
  });
});

describe("purchaseSubscription 可购额算在途预留", () => {
  /** 一条占着钱的在途任务。只有 `ownerId` / `status` / `priceCny` 参与预留计算。 */
  function inFlightJob(ownerId: string, priceCny: number, tag: string): JobRecord {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      id: `job_sub_${tag}`,
      ownerId,
      status: "pending",
      progress: 0,
      mode: "text_to_video",
      model: "grok-imagine-video-1.5",
      provider: "mock",
      prompt: "在途任务",
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

  it("在途任务占住的钱不能再拿去买订阅", async () => {
    const id = userId("res1");
    await seedUser(id, 25);
    await writeJob(inFlightJob(id, 10, "res1"));
    // 已购 25 − 在途 10 = 可购 15 < 月费 19.1。
    await expect(buy(id, "standard", "monthly")).rejects.toMatchObject({
      status: 402,
      code: "insufficient_balance",
      needCny: STANDARD_MONTHLY,
      purchasableCny: 15,
    });
    expect((await readUser(id))?.subscription).toBeUndefined();
  });

  it("扣掉预留之后还够就照常买得下来", async () => {
    const id = userId("res2");
    await seedUser(id, 30);
    await writeJob(inFlightJob(id, 10, "res2"));
    // 30 − 10 = 20 ≥ 19.1。
    const result = await buy(id, "standard", "monthly");
    expect(result.paidCny).toBe(STANDARD_MONTHLY);
  });
});

describe("年付的期数", () => {
  it("expiresAt = startedAt + 360 天（12 期 × 30 天）", async () => {
    const id = userId("yr1");
    await seedUser(id, 500);
    const { subscription } = await buy(id, "standard", "yearly");
    const span = Date.parse(subscription.expiresAt) - Date.parse(subscription.startedAt);
    expect(span).toBe(12 * 30 * DAY_MS);
  });

  it("期号上限是 11（第 12 期），最后一期结束就是到期", async () => {
    const id = userId("yr2");
    await seedUser(id, 500);
    await buy(id, "standard", "yearly");
    // 第 359 天：还没到期，落在最后一期（index 11）。
    const late = await settleSubscription(id, new Date(Date.now() + 359 * DAY_MS));
    expect(late?.subscription?.periodIndex).toBe(11);
    expect(late?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
    // 第 361 天：过了 360 天的终点 → 清零、删记录。
    const done = await settleSubscription(id, new Date(Date.now() + 361 * DAY_MS));
    expect(done?.subscription).toBeUndefined();
    expect(done?.memberCreditsCny).toBe(0);
  });

  it("月付只有一期：期号永远停在 0", async () => {
    const id = userId("yr3");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const settled = await settleSubscription(id, new Date(Date.now() + 29 * DAY_MS));
    expect(settled?.subscription?.periodIndex).toBe(0);
  });
});

describe("settleSubscription 补发本期会员积分", () => {
  it("入账行丢了（崩在扣款与入账之间）时补发，不必等到下一期", async () => {
    const id = userId("fix1");
    await seedUser(id, 100);
    const { subscription } = await buy(id, "standard", "monthly");

    // 造出那个崩溃状态：会员池是空的，流水里也没有本期的入账行。
    const rows = await ledgerLines(id);
    const kept = rows.filter((l) => l.ref !== `sub:${subscription.id}:p0`);
    expect(kept).toHaveLength(rows.length - 1);
    await writeFile(ledgerFilePath(id), kept.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    const user = await readUser(id);
    await writeUser({ ...user!, memberCreditsCny: 0 });

    const settled = await settleSubscription(id);
    // 本期额度补回来了（当天的日积分早在购买后的第一次结算里发过，这里不重复）。
    expect(settled?.memberCreditsCny).toBeGreaterThanOrEqual(STANDARD_PERIOD_CNY);
    expect(
      (await ledgerLines(id)).filter((l) => l.ref === `sub:${subscription.id}:p0`),
    ).toHaveLength(1);
  });

  it("稳态下重复结算不会多发一分钱（`ref` 幂等）", async () => {
    const id = userId("fix2");
    await seedUser(id, 100);
    await buy(id, "standard", "monthly");
    const now = new Date();
    for (let i = 0; i < 5; i += 1) await settleSubscription(id, now);
    expect((await readUser(id))?.memberCreditsCny).toBe(STANDARD_PERIOD_CNY + DAILY_CNY);
  });
});
