import { z } from "zod";

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
  disabled: z.boolean().optional(),
  /** Which one-time invite created this account (traceability, plan §6.4). */
  inviteCode: z.string().regex(INVITE_CODE_RE).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
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
};

export function toPublicUser(user: UserRecord): UserPublic {
  return { userId: user.id, email: user.email, plan: user.plan };
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
