import { ApiError, parseAuthed, parseJson } from "@/lib/client/http";
import { DEFAULT_PRICE_TABLE, type PriceTable } from "@/lib/billing/prices";

/**
 * Browser wrappers over the auth endpoints and `GET /api/me`. Components never
 * call `fetch` themselves (AGENTS.md), so this is the only door to them.
 *
 * The session itself is an HttpOnly cookie set by the server, so nothing here
 * returns or stores a token: after a successful login/register the caller just
 * navigates.
 */

/**
 * `GET /api/me`. `quota` is added by the quota batch (plan §6.3) and may be
 * absent — every consumer has to render without it.
 */
export type QuotaPublic = {
  limit: number;
  used: number;
  inFlight: number;
  remaining: number;
  /** ISO timestamp of the next Asia/Shanghai midnight. */
  resetsAt: string;
};

/** 余额模型（方案 §3.2）：`available = balance − 在途预留`，提交面板拿它判够不够。 */
export type BalancePublic = {
  balanceCny: number;
  reservedCny: number;
  availableCny: number;
};

export type MePublic = {
  userId: string;
  email: string;
  plan: string;
  balance?: BalancePublic;
  /** 服务端当前生效的价目表；缺失时调用方用 `DEFAULT_PRICE_TABLE` 也算不错。 */
  prices?: PriceTable;
  quota?: QuotaPublic;
};

/** Defensive: the shape is server-owned and grows, so only trust what we checked. */
function readQuota(raw: unknown): QuotaPublic | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  const nums = ["limit", "used", "inFlight", "remaining"] as const;
  if (!nums.every((k) => typeof q[k] === "number" && Number.isFinite(q[k]))) return undefined;
  return {
    limit: q.limit as number,
    used: q.used as number,
    inFlight: q.inFlight as number,
    remaining: q.remaining as number,
    resetsAt: typeof q.resetsAt === "string" ? q.resetsAt : "",
  };
}

/** 同样只信检查过的字段：三个数缺一个，整块余额读数就不渲染（而不是显示 ¥NaN）。 */
function readBalance(raw: unknown): BalancePublic | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const nums = ["balanceCny", "reservedCny", "availableCny"] as const;
  if (!nums.every((k) => typeof b[k] === "number" && Number.isFinite(b[k]))) return undefined;
  return {
    balanceCny: b.balanceCny as number,
    reservedCny: b.reservedCny as number,
    availableCny: b.availableCny as number,
  };
}

/** 价目表只按默认表的形状取，缺项补默认——服务端加了新档也不会算出 undefined。 */
function readPrices(raw: unknown): PriceTable | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<PriceTable>;
  const video = (p.video ?? {}) as Partial<PriceTable["video"]>;
  const image = (p.image ?? {}) as Partial<PriceTable["image"]>;
  const pick = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const d = DEFAULT_PRICE_TABLE;
  return {
    video: {
      "5": pick(video["5"], d.video["5"]),
      "10": pick(video["10"], d.video["10"]),
      hd: pick(video.hd, d.video.hd),
      audio: pick(video.audio, d.video.audio),
    },
    extend: pick(p.extend, d.extend),
    edit: pick(p.edit, d.edit),
    image: { "1k": pick(image["1k"], d.image["1k"]), "2k": pick(image["2k"], d.image["2k"]) },
  };
}

export async function fetchMe(): Promise<MePublic> {
  const res = await fetch("/api/me", { cache: "no-store" });
  const data = await parseAuthed<MePublic & { quota?: unknown; balance?: unknown; prices?: unknown }>(
    res,
    "无法读取账号信息",
  );
  return {
    userId: data.userId,
    email: data.email,
    plan: data.plan,
    balance: readBalance(data.balance),
    prices: readPrices(data.prices),
    quota: readQuota(data.quota),
  };
}

export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & { inviteCode: string };

/** 401 here means "wrong password", not "session expired" — never redirect. */
export async function login(input: LoginInput): Promise<MePublic> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJson<MePublic>(res, "登录失败");
}

export async function register(input: RegisterInput): Promise<MePublic> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJson<MePublic>(res, "注册失败");
}

/** Idempotent server-side: it only clears the cookie. */
export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  await parseJson<{ ok: boolean }>(res, "退出失败");
}

const AUTH_MESSAGES: Record<string, string> = {
  invite_invalid: "邀请码无效或已使用",
  email_taken: "该邮箱已注册",
  invalid_credentials: "邮箱或密码不正确",
  account_disabled: "账号已被停用，请联系管理员",
  rate_limited: "操作太频繁，稍后再试",
};

/** Server copy is already Chinese; this pins the wording the plan §7 specifies. */
export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message ? error.message : "网络异常，请稍后再试";
  }
  const byCode = error.code ? AUTH_MESSAGES[error.code] : undefined;
  if (byCode) return byCode;
  if (error.status === 401) return "邮箱或密码不正确";
  if (error.status === 429) return "操作太频繁，稍后再试";
  return error.message || "操作失败，请稍后再试";
}
