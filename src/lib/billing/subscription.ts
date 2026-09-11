import { createHash } from "node:crypto";
import { loadBalanceUsage, purchasableCny } from "@/lib/billing/admission";
import { applyBalanceChangeLocked, hasEntryFor } from "@/lib/billing/ledger";
import {
  CREDITS_PER_CNY,
  DAILY_CREDITS,
  PERIOD_DAYS,
  planById,
  planPrices,
} from "@/lib/billing/plans";
import { withAdmissionLock } from "@/lib/jobs/admission";
import { ProviderHttpError } from "@/lib/providers/types";
import { withUserLock } from "@/lib/users/lock";
import type {
  SubscriptionCycle,
  SubscriptionPlanId,
  SubscriptionRecord,
  UserRecord,
  UserRecordInput,
} from "@/lib/users/schema";
import { readUser, writeUser } from "@/lib/users/store";

/**
 * 订阅的购买与惰性结算（方案 §3.2）。
 *
 * 三条硬约束，改这个文件之前先读一遍：
 *
 * 1. **订阅只能用已购余额买**（`pool: "purchased"`）。订阅送的积分进会员池，如果会员
 *    积分又能拿去买订阅，「花 ¥17 买 ¥30 面值积分 → 再拿这些积分买订阅」就是无限套利。
 * 2. **会员池期末清零**，跨期不累积。所以每一期的入账都带自己的 `ref`
 *    （`sub:<id>:p<n>`），重放不会重复给钱。
 * 3. **没有定时任务**：一切在读到这个账号时惰性结算（`GET /api/me`、
 *    `GET /api/subscription`）。因此每一步都必须幂等——同一天被读一百次，日积分只发一次。
 *
 * 所有写操作都在 `withUserLock` 里，且复用 `applyBalanceChangeLocked` 这一个扣款 /
 * 入账内核（AGENTS.md：不新开扣款路径）。
 */

const DAY_MS = 86_400_000;
const PERIOD_MS = PERIOD_DAYS * DAY_MS;

/** 与配额同一条纪律：全站一个时区，不按用户所在地算「今天」。 */
export const SUBSCRIPTION_TIME_ZONE = "Asia/Shanghai";

/** 每日赠送折成人民币元（60 积分 = ¥0.6）。 */
export const DAILY_CREDITS_CNY = round2(DAILY_CREDITS / CREDITS_PER_CNY);

/**
 * 订阅 id 由幂等键**推导**（`sub_` + sha256 前 8 字节，与 `usr_` 同形），不随机。
 *
 * 随机的话，同一次购买重试时会换一个新 id，于是后面每一步的幂等键（会员积分入账
 * `sub:<id>:p0`）也跟着换——等于没有幂等键。推导出来的 id 让整次购买在同一个 key 下
 * 完全确定：重试写的是同一份记录、发的是同一行入账。
 */
export function subscriptionIdFor(idempotencyKey: string): string {
  return `sub_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`;
}

/** 一个计费周期含几个 30 天期。 */
export function periodsOf(cycle: SubscriptionCycle): number {
  return cycle === "yearly" ? 12 : 1;
}

/** Asia/Shanghai 的 `YYYY-MM-DD`。`en-CA` 的日期格式正好就是这个形状。 */
export function shanghaiDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SUBSCRIPTION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** 这一档一期发多少钱进会员池（人民币元）。 */
export function periodCreditsCny(planId: SubscriptionPlanId): number {
  const plan = planById(planId);
  return plan ? round2(plan.credits / CREDITS_PER_CNY) : 0;
}

/**
 * 402 的载荷要多带两个数（还差多少、现在能买多少），所以单独一个类型。
 *
 * `purchasableCny` 不是已购余额本身，而是**扣掉在途任务预留之后**还能拿去买订阅的钱
 * （`admission.purchasableCny`）——用户看到的数必须和判据是同一个，否则「我明明有 20 元」
 * 就成了一个没人答得上来的问题。
 */
export class InsufficientBalanceError extends ProviderHttpError {
  constructor(
    readonly needCny: number,
    readonly purchasableCny: number,
  ) {
    super(402, "insufficient_balance", "已购余额不足，请先兑换礼品码");
    this.name = "InsufficientBalanceError";
  }
}

/** `GET /api/subscription` 与 `GET /api/me` 里的 `mine`（§5 契约）。 */
export type SubscriptionPublic = {
  id: string;
  planId: SubscriptionPlanId;
  cycle: SubscriptionCycle;
  startedAt: string;
  expiresAt: string;
  periodIndex: number;
  periodStartedAt: string;
  /** 会员池当前余量，人民币元。 */
  memberCreditsCny: number;
  /** 今天（Asia/Shanghai）的每日积分发过没有。 */
  dailyGrantedToday: boolean;
};

export function publicSubscription(
  user: UserRecord | null,
  now: Date = new Date(),
): SubscriptionPublic | null {
  const sub = user?.subscription;
  if (!user || !sub) return null;
  return {
    id: sub.id,
    planId: sub.planId,
    cycle: sub.cycle,
    startedAt: sub.startedAt,
    expiresAt: sub.expiresAt,
    periodIndex: sub.periodIndex,
    periodStartedAt: sub.periodStartedAt,
    memberCreditsCny: round2(user.memberCreditsCny),
    dailyGrantedToday: sub.lastDailyGrantOn === shanghaiDay(now),
  };
}

/**
 * 惰性结算：到期清零 / 跨期重置 / 今天的日积分。返回结算后的用户记录（账号不存在时 null）。
 *
 * 读到这个账号的路由（`/api/me`、`/api/subscription`）在做任何余额判断**之前**调它，
 * 否则界面会先显示一份过期的会员池。
 */
export async function settleSubscription(
  userId: string,
  now: Date = new Date(),
): Promise<UserRecord | null> {
  // 无事可做时**不进锁**：`GET /api/me` 是壳一直在轮询的那条路由，而 `withUserLock` 是
  // 一条进程级串行队列（扣款 / 改密都排在上面）。稳态下（订阅在有效期内、今天的日积分
  // 已经发过）这里只是一次 user.json 读，不该把整条队列排上。判据与锁内那份一致，
  // 锁内还会再判一次，所以这条快路径最多是「白判一次」，不会漏结算。
  const user = await readUser(userId);
  if (!user) return null;
  if (!needsSettling(user, now) && !(await periodGrantMissing(user))) return user;
  return withUserLock(() => settleSubscriptionLocked(userId, now));
}

/**
 * 本期的会员积分入账行还在不在。
 *
 * 唯一会让它「不在」的情形是崩在两步之间（扣款成功 / periodIndex 已写、入账还没落地），
 * 稳态下永远是 `false`——所以它只是一次**无锁**的流水读，不会把 `/api/me` 的轮询排上
 * 那条进程级用户锁队列。真缺了才进锁，由 `settleSubscriptionLocked` 无条件补发（`ref` 幂等）。
 */
async function periodGrantMissing(user: UserRecord): Promise<boolean> {
  const sub = user.subscription;
  if (!sub) return false;
  if (!(periodCreditsCny(sub.planId) > 0)) return false;
  return !(await hasEntryFor(user.id, "grant", `sub:${sub.id}:p${sub.periodIndex}`));
}

/** 这一刻还有没有结算动作要做（到期 / 跨期 / 今天的日积分 / 孤儿会员积分）。 */
function needsSettling(user: UserRecord, now: Date): boolean {
  const sub = user.subscription;
  if (!sub) return user.memberCreditsCny > 0;
  const nowMs = now.getTime();
  const expiresMs = Date.parse(sub.expiresAt);
  if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) return true;
  const startedMs = Date.parse(sub.startedAt);
  if (Number.isFinite(startedMs)) {
    const elapsed = Math.floor((nowMs - startedMs) / PERIOD_MS);
    const target = Math.min(Math.max(0, elapsed), periodsOf(sub.cycle) - 1);
    if (target > sub.periodIndex) return true;
  }
  return sub.lastDailyGrantOn !== shanghaiDay(now);
}

/**
 * `settleSubscription` 的锁内内核（购买流程要在同一个临界区里先结算再判 409）。
 * **调用方必须已经持有 `withUserLock`**。
 */
export async function settleSubscriptionLocked(
  userId: string,
  now: Date = new Date(),
): Promise<UserRecord | null> {
  let user = await readUser(userId);
  if (!user) return null;

  const sub = user.subscription;
  if (!sub) {
    // 没订阅却还留着会员积分：只可能是上一次清零崩在半路（或手工改过记录）。
    // 会员积分离开订阅就没有存在的理由，扫地出门——没有 `ref`，因为它本来就不该发生，
    // 每发现一次就记一行。
    return zeroMemberPool(user, userId, "会员积分清零（无生效订阅）");
  }

  const nowMs = now.getTime();
  const expiresMs = Date.parse(sub.expiresAt);
  if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) {
    user = await zeroMemberPool(user, userId, "订阅到期，会员积分清零", `sub:${sub.id}:end`);
    return writeUser(withoutSubscription(user));
  }

  let record: SubscriptionRecord = sub;

  // ① 跨期：会员池**重置**（未用完的清零），不累积。
  const startedMs = Date.parse(sub.startedAt);
  if (Number.isFinite(startedMs)) {
    const elapsed = Math.floor((nowMs - startedMs) / PERIOD_MS);
    const target = Math.min(Math.max(0, elapsed), periodsOf(sub.cycle) - 1);
    if (target > record.periodIndex) {
      user = await zeroMemberPool(
        user,
        userId,
        "订阅续期，上期会员积分清零",
        `sub:${sub.id}:p${target}:reset`,
      );
      record = {
        ...record,
        periodIndex: target,
        periodStartedAt: new Date(startedMs + target * PERIOD_MS).toISOString(),
      };
    }
  }

  // ② 本期的会员积分，**无条件**发一次。`ref`（`sub:<id>:p<n>`）保证一期最多一行，所以
  //    稳态下这是个纯空操作；它存在是为了补两个真实的窟窿：购买时「扣款成功、入账前崩掉」
  //    （用户付了钱却没拿到积分），以及跨期时「periodIndex 写完、入账前崩掉」。只在跨期
  //    分支里发的话，这两种崩溃要等到下一期才自愈——那是 30 天。
  const periodGrant = periodCreditsCny(record.planId);
  if (periodGrant > 0) {
    user = await applyBalanceChangeLocked(
      userId,
      periodGrant,
      {
        kind: "grant",
        amountCny: periodGrant,
        ref: `sub:${sub.id}:p${record.periodIndex}`,
        note: "订阅本期会员积分",
      },
      { pool: "member" },
    );
  }

  // ③ 每日积分。`ref` 带日期，所以一天最多一行——哪怕这一秒有十个请求同时进来
  //    （它们在同一把锁上排队，第二个进来时流水里已经有那一行了）。
  const today = shanghaiDay(now);
  if (record.lastDailyGrantOn !== today && DAILY_CREDITS_CNY > 0) {
    user = await applyBalanceChangeLocked(
      userId,
      DAILY_CREDITS_CNY,
      {
        kind: "grant",
        amountCny: DAILY_CREDITS_CNY,
        ref: `sub:${sub.id}:d${today}`,
        note: "订阅每日赠送积分",
      },
      { pool: "member" },
    );
    record = { ...record, lastDailyGrantOn: today };
  }

  if (record !== sub) user = await writeUser({ ...user, subscription: record });
  return user;
}

export type SubscriptionPurchase = {
  user: UserRecord;
  subscription: SubscriptionRecord;
  /** 这次实际扣掉的钱（人民币元，正数）。 */
  paidCny: number;
  /** 同一个幂等键的重放：什么都没再发生，返回的是上一次买下的那份订阅。 */
  replay: boolean;
};

/** 一档一个周期要付多少钱。 */
function priceOf(planId: SubscriptionPlanId, cycle: SubscriptionCycle): number {
  const plan = planById(planId);
  if (!plan) return 0;
  const prices = planPrices(plan);
  return cycle === "yearly" ? prices.yearlyCny : prices.monthlyCny;
}

/**
 * 买一份订阅。
 *
 * 顺序（方案 §3.2）：结算旧订阅 → 判重放 / 409 / 402 → **扣已购余额** → 写 `subscription` →
 * 会员池置为本期积分。全程一把 `withUserLock`。
 *
 * `idempotencyKey` 由浏览器一次「确认订阅」生成一个，扣款行的 `ref` 就是 `sub:<key>`。
 * 它挡的是双击、超时重发与「回执丢了、用户又点一次」：同一个 key 再来一次拿回的是**同一份**
 * 订阅（200），而不是 409，更不会扣第二笔钱——`applyBalanceChangeLocked` 按 `ref` 去重，
 * 这里再按同一个 `ref` 判一次重放，两层都靠流水，不引入第二份状态。
 *
 * ⚠️ 崩溃窗口：扣款成功、还没写 `subscription` 时崩掉。用户重试（同 key）会走到扣款那一步，
 * 被幂等挡下不再扣钱，然后把 `subscription` 补写出来——窗口因此自愈，而不是只留一行流水
 * 等管理员退款。会员池的入账同样有 `ref`，`settleSubscription` 每次都会补发。
 */
export async function purchaseSubscription(
  userId: string,
  planId: SubscriptionPlanId,
  cycle: SubscriptionCycle,
  idempotencyKey: string,
): Promise<SubscriptionPurchase> {
  return withAdmissionLock(() => withUserLock(async () => {
    const now = new Date();
    const id = subscriptionIdFor(idempotencyKey);
    const ref = `sub:${idempotencyKey}`;
    // 先结算：昨天刚到期的订阅必须在这里被清掉，否则它会把这次购买挡成 409。
    let user = await settleSubscriptionLocked(userId, now);
    if (!user) throw new ProviderHttpError(401, "unauthorized", "请先登录");
    const charged = await hasEntryFor(userId, "charge", ref);
    if (user.subscription) {
      if (charged) {
        // 重放：这个 key 已经买下过，而且那份订阅还在。原样把它交回去（200），
        // `paidCny` 按当前价目重算——两次调用之间只隔几秒，价格不会变。
        const sub = user.subscription;
        return { user, subscription: sub, paidCny: priceOf(sub.planId, sub.cycle), replay: true };
      }
      throw new ProviderHttpError(409, "subscription_active", "已有生效中的订阅");
    }
    const plan = planById(planId);
    if (!plan) throw new ProviderHttpError(400, "invalid_argument", "未知的订阅档位");
    const grant = periodCreditsCny(planId);
    if (charged) {
      // 扣过款、订阅却不在了。两种可能，靠「本期入账行在不在」分辨——它是每一次成功
      // 购买都会留下的痕迹（`sub:<id>:p0`，id 由 key 推导所以可预测）：
      //
      //  · 有那一行 → 订阅真的建成过、如今已经到期被清掉。放行等于让人拿一把旧 key
      //    白换一份新订阅（扣款会被幂等跳过），必须拒绝。
      //  · 没有那一行 → 崩在「扣款成功、写订阅之前」的那道窗口里。补建出来即可，
      //    扣款照样被幂等跳过，所以用户不会被扣第二笔。
      //
      // 档位积分为 0 时这个痕迹不存在，分辨不了就一律拒绝——宁可让人重来一次。
      const everGranted = grant > 0 && (await hasEntryFor(userId, "grant", `sub:${id}:p0`));
      if (everGranted || !(grant > 0)) {
        throw new ProviderHttpError(
          400,
          "idempotency_key_reused",
          "这次请求已经处理过了，请刷新页面后重试",
        );
      }
    }
    const priceCny = priceOf(planId, cycle);
    if (!(priceCny > 0)) throw new ProviderHttpError(500, "internal", "订阅价格暂不可用");
    // 只看已购池（会员积分买不了订阅，本文件顶部第 1 条），而且要减掉在途任务已经占住的
    // 那部分——那些任务结算时还要从这个池子里出钱。
    const purchasable = purchasableCny(await loadBalanceUsage(userId, now.getTime()));
    if (purchasable < priceCny) {
      throw new InsufficientBalanceError(priceCny, purchasable);
    }

    const startedAt = now.toISOString();
    const subscription: SubscriptionRecord = {
      id,
      planId,
      cycle,
      startedAt,
      expiresAt: new Date(now.getTime() + periodsOf(cycle) * PERIOD_MS).toISOString(),
      periodIndex: 0,
      periodStartedAt: startedAt,
    };

    user = await applyBalanceChangeLocked(
      userId,
      -priceCny,
      {
        kind: "charge",
        amountCny: -priceCny,
        ref,
        note: `订阅 ${plan.name}（${cycle === "yearly" ? "年付" : "月付"}）`,
      },
      { pool: "purchased" },
    );
    user = await writeUser({ ...user, subscription });

    // 会员池「置为」本期积分而不是「加上」：上一份订阅的余额早在结算时清过零，
    // 这里再做一次差额调整只会把一个本该恒等的值变成可能漂移的值。
    if (user.memberCreditsCny > 0) {
      user = await zeroMemberPool(user, userId, "订阅生效，重置会员积分", `sub:${id}:p0:reset`);
    }
    if (grant > 0) {
      user = await applyBalanceChangeLocked(
        userId,
        grant,
        { kind: "grant", amountCny: grant, ref: `sub:${id}:p0`, note: "订阅本期会员积分" },
        { pool: "member" },
      );
    }
    return { user, subscription, paidCny: priceCny, replay: false };
  }));
}

/** 会员池清零：池子空着就什么都不做（也不记一行「+0」的流水）。 */
async function zeroMemberPool(
  user: UserRecord,
  userId: string,
  note: string,
  ref?: string,
): Promise<UserRecord> {
  const amount = round2(user.memberCreditsCny);
  if (!(amount > 0)) return user;
  return applyBalanceChangeLocked(
    userId,
    -amount,
    { kind: "adjust", amountCny: -amount, ...(ref ? { ref } : {}), note },
    { pool: "member" },
  );
}

/** 删掉 `subscription` 字段（`writeUser` 收的是可选字段的输入形状）。 */
function withoutSubscription(user: UserRecord): UserRecordInput {
  const next: Record<string, unknown> = { ...user };
  delete next.subscription;
  return next as UserRecordInput;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
