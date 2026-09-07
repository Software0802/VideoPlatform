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

/**
 * 余额模型（方案 §3.2）：`available = 已购余额 + 会员积分 − 在途预留`，提交面板拿它
 * 判够不够。两个池分开报，是因为它们能干的事不一样：订阅只能用已购池买。
 */
export type BalancePublic = {
  balanceCny: number;
  /** 订阅送的会员积分池（期末清零）。老服务端不下发这个字段，读出即 0。 */
  memberCreditsCny: number;
  reservedCny: number;
  availableCny: number;
};

/** `GET /api/me` 里的订阅摘要（订阅页要的完整形状在 `@/lib/client/subscription`）。 */
export type SubscriptionSummary = {
  id: string;
  planId: string;
  cycle: string;
  expiresAt: string;
  memberCreditsCny: number;
  dailyGrantedToday: boolean;
};

export type MePublic = {
  userId: string;
  email: string;
  plan: string;
  balance?: BalancePublic;
  /** 服务端当前生效的价目表；缺失时调用方用 `DEFAULT_PRICE_TABLE` 也算不错。 */
  prices?: PriceTable;
  quota?: QuotaPublic;
  /** 没订阅（或老服务端）时为 null。 */
  subscription?: SubscriptionSummary | null;
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

/**
 * 同样只信检查过的字段：三个数缺一个，整块余额读数就不渲染（而不是显示 ¥NaN）。
 * `memberCreditsCny` 是后加的，不进必填集合——老服务端没有它，读出按 0 算，
 * 界面上「会员积分 0」是对的。
 */
function readBalance(raw: unknown): BalancePublic | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const nums = ["balanceCny", "reservedCny", "availableCny"] as const;
  if (!nums.every((k) => typeof b[k] === "number" && Number.isFinite(b[k]))) return undefined;
  return {
    balanceCny: b.balanceCny as number,
    memberCreditsCny: money(b.memberCreditsCny),
    reservedCny: b.reservedCny as number,
    availableCny: b.availableCny as number,
  };
}

function money(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 订阅摘要：id / planId 认不出就当没订阅，宁可少显示一块也不显示半块。 */
function readSubscription(raw: unknown): SubscriptionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === "string" ? s.id : "";
  const planId = typeof s.planId === "string" ? s.planId : "";
  if (!id || !planId) return null;
  return {
    id,
    planId,
    cycle: typeof s.cycle === "string" ? s.cycle : "monthly",
    expiresAt: typeof s.expiresAt === "string" ? s.expiresAt : "",
    memberCreditsCny: money(s.memberCreditsCny),
    dailyGrantedToday: s.dailyGrantedToday === true,
  };
}

/** 价目表只按默认表的形状取，缺项补默认——服务端加了新档也不会算出 undefined。 */
function readPrices(raw: unknown): PriceTable | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<PriceTable>;
  const video = (p.video ?? {}) as Partial<PriceTable["video"]>;
  const image = (p.image ?? {}) as Partial<PriceTable["image"]>;
  const agent = (p.agent ?? {}) as Partial<PriceTable["agent"]>;
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
    agent: { turn: pick(agent.turn, d.agent.turn) },
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
    subscription: readSubscription((data as { subscription?: unknown }).subscription),
  };
}

/* ── 礼品码与积分流水（阶段 A 契约） ── */

/** `POST /api/me/redeem` 的成功回执：这次到账多少、兑换后余额是多少（均为人民币元）。 */
export type RedeemResult = { amountCny: number; balance: BalancePublic | null };

export async function redeemGiftCode(code: string): Promise<RedeemResult> {
  const res = await fetch("/api/me/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await parseAuthed<{ amountCny?: unknown; balance?: unknown }>(res, "兑换失败");
  return {
    amountCny: typeof data.amountCny === "number" && Number.isFinite(data.amountCny) ? data.amountCny : 0,
    // `balance` 只是省一次 /api/me 的顺手回执；形状不对就当没给，调用方照常重拉。
    balance: readBalance(data.balance) ?? null,
  };
}

/** 码来自 `src/lib/users/gift-codes.ts`（404 / 409）与兑换路由的限流（429）。 */
const REDEEM_MESSAGES: Record<string, string> = {
  gift_code_invalid: "礼品码无效",
  gift_code_used: "礼品码已被使用",
  rate_limited: "兑换太频繁，稍后再试",
};

/**
 * 兑换失败的文案。服务端的码是事实源，这里只把已知的几种钉成固定中文；认不出的码
 * 一律回落服务端自己那句话（而不是吞成「兑换失败」，那会让用户不知道到底哪一步不对）。
 */
export function redeemErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message ? error.message : "网络异常，请稍后再试";
  }
  const byCode = error.code ? REDEEM_MESSAGES[error.code] : undefined;
  if (byCode) return byCode;
  if (error.status === 429) return "兑换太频繁，稍后再试";
  return error.message || "兑换失败，请稍后再试";
}

/** 一条积分流水。`kind` 由服务端定义（`grant` 是充值 / 兑换，其余是消费类）。 */
export type LedgerEntry = {
  at: string;
  kind: string;
  amountCny: number;
  balanceAfterCny: number;
  jobId?: string;
  note?: string;
};

export type LedgerPage = { entries: LedgerEntry[]; nextBefore?: string };

function readLedgerEntry(raw: unknown): LedgerEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const at = typeof e.at === "string" ? e.at : "";
  const kind = typeof e.kind === "string" ? e.kind : "";
  if (!at || !kind) return null;
  const money = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    at,
    kind,
    amountCny: money(e.amountCny),
    balanceAfterCny: money(e.balanceAfterCny),
    jobId: typeof e.jobId === "string" ? e.jobId : undefined,
    note: typeof e.note === "string" ? e.note : undefined,
  };
}

/** `GET /api/me/ledger`。`before` 传上一页的 `nextBefore` 就是「加载更多」。 */
export async function fetchLedger(opts: { before?: string; limit?: number; kind?: string } = {}): Promise<LedgerPage> {
  const q = new URLSearchParams();
  if (opts.before) q.set("before", opts.before);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.kind) q.set("kind", opts.kind);
  const suffix = q.size ? `?${q.toString()}` : "";
  const res = await fetch(`/api/me/ledger${suffix}`, { cache: "no-store" });
  const data = await parseAuthed<{ entries?: unknown; nextBefore?: unknown }>(res, "无法读取积分流水");
  const raw = Array.isArray(data.entries) ? data.entries : [];
  return {
    entries: raw.map(readLedgerEntry).filter((e): e is LedgerEntry => e !== null),
    nextBefore: typeof data.nextBefore === "string" && data.nextBefore ? data.nextBefore : undefined,
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

/**
 * `POST /api/auth/password { currentPassword, newPassword }`（阶段 B 契约）。
 *
 * 401 在这里同样是「旧密码不对」而不是「会话过期」，所以走 `parseJson` 而不是
 * `parseAuthed`——被 `redirectToLogin` 弹走的话，用户连错在哪都看不到。
 */
export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  const res = await fetch("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await parseJson<{ ok?: boolean }>(res, "修改密码失败");
}

const PASSWORD_MESSAGES: Record<string, string> = {
  invalid_credentials: "当前密码不正确",
  weak_password: "新密码太简单，请换一个",
  rate_limited: "操作太频繁，稍后再试",
};

/** 与 `authErrorMessage` 同一个口径：认得的码钉成固定中文，认不出的回落服务端那句话。 */
export function passwordErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message ? error.message : "网络异常，请稍后再试";
  }
  const byCode = error.code ? PASSWORD_MESSAGES[error.code] : undefined;
  if (byCode) return byCode;
  if (error.status === 401 || error.status === 403) return "当前密码不正确";
  if (error.status === 429) return "操作太频繁，稍后再试";
  return error.message || "修改密码失败，请稍后再试";
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
