import { ApiError, parseAuthed, parseJson } from "@/lib/client/http";

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

export type MePublic = {
  userId: string;
  email: string;
  plan: string;
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

export async function fetchMe(): Promise<MePublic> {
  const res = await fetch("/api/me", { cache: "no-store" });
  const data = await parseAuthed<MePublic & { quota?: unknown }>(res, "无法读取账号信息");
  return { userId: data.userId, email: data.email, plan: data.plan, quota: readQuota(data.quota) };
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
