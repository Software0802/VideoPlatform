import { ApiError, parseAuthed } from "@/lib/client/http";
import type { BalancePublic } from "@/lib/client/auth";

/**
 * 浏览器访问 `/api/subscription` 的唯一入口（AGENTS.md：组件不直接 `fetch`）。
 *
 * 这里**不 import** `@/lib/billing/plans`：那个模块要读产品目录 → 路由 → 全部 provider，
 * 一旦被客户端组件牵进来就会把服务端依赖打进浏览器包。价格与档位全部由服务端下发，
 * 这里只负责把它读成一个自己检查过的形状。
 */

export type PlanCycle = "monthly" | "yearly";

export type SubscriptionPlan = {
  id: string;
  /** 服务端给的中文档位名；界面优先用 i18n 的 `subscription.plan<Id>`，这个是兜底。 */
  name: string;
  credits: number;
  dailyCredits: number;
  monthlyCny: number;
  yearlyCny: number;
  popular?: boolean;
  /** i18n 键名，由界面翻译（服务端不翻译）。 */
  features: string[];
};

export type MySubscription = {
  id: string;
  planId: string;
  cycle: PlanCycle;
  startedAt: string;
  expiresAt: string;
  periodIndex: number;
  periodStartedAt: string;
  memberCreditsCny: number;
  dailyGrantedToday: boolean;
};

export type SubscriptionState = {
  plans: SubscriptionPlan[];
  mine: MySubscription | null;
};

export type PurchaseResult = { mine: MySubscription | null; balance: BalancePublic | null };

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readCycle(value: unknown): PlanCycle {
  return value === "yearly" ? "yearly" : "monthly";
}

/** 一档：id 与两个价缺一不可，其余缺了给默认值——半张卡片比没有卡片更容易骗人。 */
function readPlan(raw: unknown): SubscriptionPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  if (!id) return null;
  const monthlyCny = num(p.monthlyCny, -1);
  const yearlyCny = num(p.yearlyCny, -1);
  if (monthlyCny < 0 || yearlyCny < 0) return null;
  return {
    id,
    name: str(p.name, id),
    credits: num(p.credits),
    dailyCredits: num(p.dailyCredits),
    monthlyCny,
    yearlyCny,
    ...(p.popular === true ? { popular: true } : {}),
    features: Array.isArray(p.features) ? p.features.filter((f): f is string => typeof f === "string") : [],
  };
}

function readMine(raw: unknown): MySubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = str(s.id);
  const planId = str(s.planId);
  if (!id || !planId) return null;
  return {
    id,
    planId,
    cycle: readCycle(s.cycle),
    startedAt: str(s.startedAt),
    expiresAt: str(s.expiresAt),
    periodIndex: num(s.periodIndex),
    periodStartedAt: str(s.periodStartedAt),
    memberCreditsCny: num(s.memberCreditsCny),
    dailyGrantedToday: s.dailyGrantedToday === true,
  };
}

function readBalance(raw: unknown): BalancePublic | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.balanceCny !== "number" || !Number.isFinite(b.balanceCny)) return null;
  return {
    balanceCny: b.balanceCny,
    memberCreditsCny: num(b.memberCreditsCny),
    reservedCny: num(b.reservedCny),
    availableCny: num(b.availableCny, b.balanceCny),
  };
}

/** `GET /api/subscription`。 */
export async function fetchSubscription(): Promise<SubscriptionState> {
  const res = await fetch("/api/subscription", { cache: "no-store" });
  const data = await parseAuthed<{ plans?: unknown; mine?: unknown }>(res, "无法读取订阅信息");
  const plans = Array.isArray(data.plans) ? data.plans : [];
  return {
    plans: plans.map(readPlan).filter((p): p is SubscriptionPlan => p !== null),
    mine: readMine(data.mine),
  };
}

/**
 * `POST /api/subscription`。402 / 409 由调用方按 `subscriptionErrorCode` 分支。
 *
 * `idempotencyKey` 是必填的：一次「确认订阅」一个 key，提交成功前不换。双击、超时重发、
 * 「回执丢了再点一次」拿回的都是同一份订阅，而不是第二笔扣款（服务端按流水去重）。
 */
export async function purchaseSubscription(
  planId: string,
  cycle: PlanCycle,
  idempotencyKey: string,
): Promise<PurchaseResult> {
  const res = await fetch("/api/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, cycle, idempotencyKey }),
  });
  const data = await parseAuthed<{ mine?: unknown; balance?: unknown }>(res, "订阅失败");
  return { mine: readMine(data.mine), balance: readBalance(data.balance) };
}

/**
 * 失败原因的**码**（不是文案）：文案要走 i18n，只有组件那边拿得到 `useT()`。
 * 认不出的一律 `unknown`，由组件回落到服务端那句话。
 */
export type SubscriptionErrorCode = "insufficient_balance" | "subscription_active" | "unknown";

export function subscriptionErrorCode(error: unknown): SubscriptionErrorCode {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.code === "insufficient_balance" || error.status === 402) return "insufficient_balance";
  if (error.code === "subscription_active" || error.status === 409) return "subscription_active";
  return "unknown";
}

/** 服务端自己那句话，`subscriptionErrorCode` 为 `unknown` 时用。 */
export function subscriptionErrorFallback(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  return error instanceof Error && error.message ? error.message : "";
}
