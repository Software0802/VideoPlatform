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
 * `consumeInvite` rather than in the request schema.
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
