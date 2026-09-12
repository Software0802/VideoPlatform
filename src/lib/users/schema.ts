import { z } from "zod";
import { billingSchema } from "@/lib/billing/protocol.mjs";

/** `usr_` + 8 random bytes, mirroring the `up_` upload id shape. */
export const USER_ID_RE = /^usr_[0-9a-f]{16}$/;

/**
 * 12 chars of base32 with the confusable letters removed (no I, L, O, U).
 * Keep in sync with the same alphabet in `scripts/mint-invites.mjs`, which
 * cannot import TypeScript.
 */
export const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LENGTH = 12;
export const INVITE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

export const userPlanSchema = z.enum(["free"]);
export type UserPlan = z.infer<typeof userPlanSchema>;

/**
 * 订阅档位 id 与计费周期（方案 §3.2）。
 *
 * 枚举的事实源放在这里而不是 `@/lib/billing/plans`，方向是刻意的：这个文件只依赖 zod，
 * 而 plans.ts 要读产品目录（→ 路由 → 全部 provider）。让用户存储反过来 import 计费，
 * 等于把整张 provider 图拉进每一个碰过 `user.json` 的模块。plans.ts 从这里 import 回去，
 * 两边永远是同一张表。
 */
export const SUBSCRIPTION_PLAN_IDS = ["standard", "pro", "premium", "ultimate"] as const;
export const subscriptionPlanIdSchema = z.enum(SUBSCRIPTION_PLAN_IDS);
export type SubscriptionPlanId = z.infer<typeof subscriptionPlanIdSchema>;

export const SUBSCRIPTION_CYCLES = ["monthly", "yearly"] as const;
export const subscriptionCycleSchema = z.enum(SUBSCRIPTION_CYCLES);
export type SubscriptionCycle = z.infer<typeof subscriptionCycleSchema>;

/** `sub_` + 8 随机字节，与 `usr_` / `up_` 同形。 */
export const SUBSCRIPTION_ID_RE = /^sub_[0-9a-f]{16}$/;

/**
 * 一份生效中的订阅（方案 §3.2）。只在 `user.json` 里，没有独立文件——它的生命周期
 * 完全绑在账号上，单独存一份只会多一个要对齐的事实源。
 *
 * 期（period）固定 30 天：月付 1 期、年付 12 期，`expiresAt` 是最后一期的终点。
 * 惰性结算（`settleSubscription`）靠 `periodIndex` / `periodStartedAt` 判断该不该
 * 重置会员池，靠 `lastDailyGrantOn` 判断今天的日积分发过没有。
 */
export const subscriptionSchema = z.object({
  id: z.string().regex(SUBSCRIPTION_ID_RE),
  planId: subscriptionPlanIdSchema,
  cycle: subscriptionCycleSchema,
  startedAt: z.string(),
  /** 到期时刻（ISO）。到点后会员池清零、这条记录被删掉。 */
  expiresAt: z.string(),
  /** 第几个 30 天期，从 0 开始。 */
  periodIndex: z.number().int().min(0),
  periodStartedAt: z.string(),
  /** 最近一次发过每日积分的日期，`YYYY-MM-DD`（Asia/Shanghai）。 */
  lastDailyGrantOn: z.string().optional(),
});
export type SubscriptionRecord = z.infer<typeof subscriptionSchema>;

/** `subscriptionActive` / `activeMemberCreditsCny` 需要的最小形状（方便测试直接构造）。 */
type SubscriptionHolder = { subscription?: SubscriptionRecord; memberCreditsCny?: number };

/**
 * 这一刻订阅还生效吗。
 *
 * 结算是**惰性**的（`settleSubscription`，没有定时任务），所以「`subscription` 字段还在」
 * 不等于「还没到期」——一个昨天到期、今天还没被任何请求读过的账号，记录原样躺在
 * `user.json` 里，会员池也还是满的。凡是拿会员积分做判定的地方（准入、扣款分池）都必须
 * 走这个函数，不能只看字段在不在，否则过期会员积分照样能花出去。
 *
 * 判据只依赖 `expiresAt`，与 `settleSubscriptionLocked` 的到期分支逐字一致
 * （`now >= expiresAt` 即到期）；时刻解析不出来一律当作已失效。
 */
export function subscriptionActive(
  user: SubscriptionHolder | null | undefined,
  now: number = Date.now(),
): boolean {
  const expiresAt = user?.subscription?.expiresAt;
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms > now;
}

/**
 * 这一刻**真正能花**的会员积分（人民币元）。订阅已过期 / 根本没有订阅时是 0，哪怕
 * `memberCreditsCny` 还留着一个正数——那笔钱只是在等下一次结算把它清掉。
 */
export function activeMemberCreditsCny(
  user: SubscriptionHolder | null | undefined,
  now: number = Date.now(),
): number {
  if (!user || !subscriptionActive(user, now)) return 0;
  const pool = user.memberCreditsCny;
  return typeof pool === "number" && Number.isFinite(pool) ? Math.max(0, pool) : 0;
}

/** Source of truth: `data/users/<id>/user.json`. */
export const userRecordSchema = z.object({
  id: z.string().regex(USER_ID_RE),
  /** Always stored normalized (trimmed + lowercased). */
  email: z.string().min(3).max(254),
  /** `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — never leaves the server. */
  passwordHash: z.string().min(1),
  /** Bumped on password change; part of the signed session payload. */
  sessionEpoch: z.number().int().min(1),
  plan: userPlanSchema,
  /**
   * 余额，人民币元（方案 §3.2）。准入判据是「余额 − 在途预留 ≥ 本次售价」，成功的
   * 任务在终态边沿扣款。只由 `@/lib/billing/ledger` 的 `applyBalanceChange` 与
   * `scripts/grant-balance.mjs` 改写，两者都在用户锁内读改写并追加一行流水。
   *
   * `.default(0)`：这个字段是后加的，用户系统上线时创建的记录里没有它，读出即 0。
   * 允许为负——预留已经放行的任务照样要结算，负数只会出现在并发边缘。
   */
  balanceCny: z.number().default(0),
  /**
   * 会员积分池，人民币元（方案 §3.2）。与 `balanceCny`（已购池）是**两个池子**：
   * 订阅赠送的积分只进这里，期末清零，而且买订阅只能花已购池——两池合一的话，
   * 「用低于面值的钱买到面值积分」就成了无限套利（买 → 得积分 → 再买）。
   *
   * 任务扣款先扣这里、不足部分才扣 `balanceCny`（`applyBalanceChangeLocked`），
   * 准入的 `available` 是两池之和减在途预留。永不为负：清零 / 扣穿都截在 0。
   *
   * `.default(0)`：后加的字段，老记录读出即 0。
   */
  memberCreditsCny: z.number().default(0),
  /** 生效中的订阅；没订阅（或已到期被结算掉）时这个字段不存在。 */
  subscription: subscriptionSchema.optional(),
  disabled: z.boolean().optional(),
  /** Which one-time invite created this account (traceability, plan §6.4). */
  inviteCode: z.string().regex(INVITE_CODE_RE).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  billing: billingSchema.optional(),
}).passthrough();
export type UserRecord = z.infer<typeof userRecordSchema>;
/**
 * 写入侧的形状：有默认值的字段（`balanceCny`）可以不写，由 `writeUser` 的 parse 补上。
 * 读出来的永远是补全后的 `UserRecord`，所以只有构造记录的那几处能省。
 */
export type UserRecordInput = z.input<typeof userRecordSchema>;

/** `data/invites/<code>.json`. */
export const inviteRecordSchema = z.object({
  code: z.string().regex(INVITE_CODE_RE),
  createdAt: z.string(),
  note: z.string().max(200).optional(),
  usedBy: z.string().regex(USER_ID_RE).optional(),
  usedAt: z.string().optional(),
});
export type InviteRecord = z.infer<typeof inviteRecordSchema>;

/**
 * `data/gift-codes/<code>.json` — 自助充值码（方案 §1.7）。
 *
 * 码型（字母表 / 长度 / 校验 / 归一化）与邀请码**完全一致**：两者都是管理员线下分发、
 * 用户手打一次的一次性口令，共用一套规则省掉第二份归一化逻辑，也让「带空格 / 小写 /
 * 连字符」的输入在两处表现相同。不加前缀区分——码放在哪个目录就决定它是什么，
 * `data/invites/` 与 `data/gift-codes/` 是两个命名空间，同一个码不会被两边同时认领。
 */
export const giftCodeRecordSchema = z.object({
  code: z.string().regex(INVITE_CODE_RE),
  /** 面额，人民币元，与 `balanceCny` 同单位。必须为正：0 元码只会让人以为兑换失败。 */
  amountCny: z.number().positive().max(100_000),
  note: z.string().max(200).optional(),
  createdAt: z.string(),
  /** 认领人。一旦写上，这个码就永久归 TA，任何人（包括 TA 自己）再兑换都是 409。 */
  usedBy: z.string().regex(USER_ID_RE).optional(),
  usedAt: z.string().optional(),
  /**
   * 入账完成的时刻。认领（`usedBy`）与入账在同一个临界区里先后发生，这个字段是
   * 「钱已经进账」的凭据：崩在两者之间时记录上有 `usedBy` 没有 `creditedAt`，
   * 同一个人再兑换一次会走补入账分支（`redeemGiftCode`），别人来则照样 409。
   */
  creditedAt: z.string().optional(),
});
export type GiftCodeRecord = z.infer<typeof giftCodeRecordSchema>;

/** Derived cache only: `{ "email@x.com": "usr_xxx" }`, rebuildable by scanning. */
export const userIndexSchema = z.record(z.string(), z.string().regex(USER_ID_RE));

/** Public projection returned by the auth endpoints and `GET /api/me`. */
export type UserPublic = {
  userId: string;
  email: string;
  plan: UserPlan;
  /** 注册时间（ISO）。账户页（H3）要展示；`sessionEpoch` / `passwordHash` 永远不下发。 */
  createdAt: string;
};

export function toPublicUser(user: UserRecord): UserPublic {
  return { userId: user.id, email: user.email, plan: user.plan, createdAt: user.createdAt };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Users type codes with spaces or dashes; strip them before matching. */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "");
}

const emailInputSchema = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .pipe(z.email("邮箱格式不正确"));

const passwordInputSchema = z.string().min(8, "密码至少 8 位").max(200);

/**
 * Only normalized here. A malformed code must fail the same way an unknown or
 * already-used one does (`invite_invalid`), so the format check lives in
 * `consumeInvite` rather than in the request schema. Gift codes reuse this for
 * the same reason (`gift_code_invalid` covers both shapes).
 */
const inviteInputSchema = z.string().max(64).transform(normalizeInviteCode);

export const registerBodySchema = z.strictObject({
  email: emailInputSchema,
  password: passwordInputSchema,
  inviteCode: inviteInputSchema,
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.strictObject({
  email: emailInputSchema,
  password: passwordInputSchema,
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/**
 * `POST /api/auth/password`（方案 §3.4「账号闭环」）。
 *
 * 旧密码只用 `z.string()` 兜住类型：它是拿去比对的，对它做长度 / 复杂度校验只会
 * 在密码规则变更前后产生「明明是对的旧密码却被 400」的假失败。新密码走注册那条
 * 同款规则——两处不一致就会出现「注册得进去、改完密码登不上」。
 */
export const changePasswordBodySchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordInputSchema,
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

/** `POST /api/me/redeem`. Same normalization as the invite code — see above. */
export const redeemBodySchema = z.strictObject({ code: inviteInputSchema });
export type RedeemBody = z.infer<typeof redeemBodySchema>;
