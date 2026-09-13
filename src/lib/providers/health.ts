import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { notifyAlert } from "@/lib/alerts";
import { dataDir, providerExhaustedTtlMs } from "@/lib/env";
import { log } from "@/lib/log";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import type { ProviderId } from "@/lib/providers/types";

/**
 * provider 健康与冷却（方案 `plan-relay-provider` §4c）：吸收旧的「耗尽 6h」一档
 * （`exhaustion.ts` 现为兼容薄壳），扩展成分级冷却。
 *
 * 键是 `provider × kind`（视频与图片常常是两套额度池，分开记）。状态：
 * - `samples`：最近 20 次 / 10 分钟内的调用结果（只进内存，不落盘）；
 * - 冷却：`cooldownUntil`（ms epoch）+ 时长档位 `cooldownMs` + `reason`，落盘
 *   `data/provider-health.json`——重启延续冷却，不该让崩溃把「已切走」失忆；
 * - 半开：冷却到期后放**一条**真实任务试探（`halfOpenProbeAt` 认领计数），成功即
 *   清零恢复，失败按翻倍再冷却（上限 15 分钟）。
 *
 * 规则：`quota_exhausted` → `PROVIDER_EXHAUSTED_TTL_MS`（默认 6h）；`rate_limited`
 * → 响应 `Retry-After` 优先，否则 60s 起连续命中翻倍（上限 15m，成功归零）；
 * 连续 3 次 5xx / 连接失败 / 读超时 → 5 分钟 + `relay_unhealthy` 告警。
 */
export type HealthKind = "video" | "image";
/** 兼容旧名。 */
export type ExhaustionKind = HealthKind;

export type ExhaustionEntry = {
  providerId: ProviderId;
  kind: HealthKind;
  /** ISO 时间，过了就自动重新参与路由。 */
  until: string;
  /** 上游当时说了什么（`ProviderHttpError.message`），排查时不用去翻日志。 */
  reason: string;
};

export type ProviderHealth = {
  providerId: ProviderId;
  kind: HealthKind;
  state: "ok" | "cooldown" | "half-open";
  until?: string;
  reason?: string;
  /** 最近窗口内的成功率（0–1），窗口为空时省略。 */
  recentSuccessRate?: number;
};

type Entry = {
  samples: { ts: number; ok: boolean; ms: number }[];
  cooldownUntil: number;
  /** 上一次冷却的时长（半开失败翻倍、rate_limited 连击翻倍的基数）。 */
  cooldownMs: number;
  reason?: string;
  /** 半开态被认领的探路任务时间戳；>0 且在 5 分钟内 = 有一个在途探路。 */
  halfOpenProbeAt: number;
  consecutiveTransient: number;
  rateLimitStreak: number;
};

const WINDOW_MS = 10 * 60_000;
const WINDOW_MAX = 20;
const TRANSIENT_TRIGGER = 3;
const TRANSIENT_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 15 * 60_000;
const PROBE_TTL_MS = 5 * 60_000;

const ENTRIES = new Map<string, Entry>();

// DATA_DIR 变了（测试给每个用例换临时目录）时，内存状态必须跟着作废——
// 旧实现是纯读文件的，天然没有这个坑。
let activeDataDir: string | null = null;

function ensureDataDir(): void {
  const dir = dataDir();
  if (activeDataDir === dir) return;
  activeDataDir = dir;
  ENTRIES.clear();
  fileCache = null;
}

function key(id: ProviderId, kind: HealthKind): string {
  return `${id}:${kind}`;
}

function entry(id: ProviderId, kind: HealthKind): Entry {
  ensureDataDir();
  const k = key(id, kind);
  let e = ENTRIES.get(k);
  if (!e) {
    e = {
      samples: [],
      cooldownUntil: 0,
      cooldownMs: 0,
      halfOpenProbeAt: 0,
      consecutiveTransient: 0,
      rateLimitStreak: 0,
    };
    ENTRIES.set(k, e);
    hydrate(e, id, kind);
  }
  return e;
}

// ── 落盘：只持久化冷却字段，窗口样本留在内存 ──────────────────────────────

type Persisted = Partial<
  Record<string, Partial<Record<HealthKind, { until: string; reason: string; cooldownMs: number }>>>
>;

function stateFile(): string {
  return path.join(dataDir(), "provider-health.json");
}

let fileCache: { path: string; mtimeMs: number; state: Persisted } | null = null;

function readPersisted(): Persisted {
  ensureDataDir();
  const file = stateFile();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    fileCache = null;
    return {};
  }
  if (fileCache && fileCache.path === file && fileCache.mtimeMs === mtimeMs) {
    return fileCache.state;
  }
  let state: Persisted = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as Persisted;
  } catch {
    state = {};
  }
  fileCache = { path: file, mtimeMs, state };
  return state;
}

/** 首次访问某键时把盘上还活着的冷却灌回内存。 */
function hydrate(e: Entry, id: ProviderId, kind: HealthKind): void {
  const rec = readPersisted()[id]?.[kind];
  if (!rec) return;
  const until = Date.parse(rec.until);
  if (!Number.isFinite(until)) return;
  e.cooldownUntil = until;
  e.cooldownMs = typeof rec.cooldownMs === "number" ? rec.cooldownMs : 0;
  e.reason = rec.reason;
}

// 串行写盘（与 exhaustion 时代的 withLock 同义）：并发的冷却写入不能互相覆盖。
let persistQueue: Promise<unknown> = Promise.resolve();

function persist(): Promise<void> {
  const run = persistQueue.then(async (): Promise<void> => {
    // 读现值再改：别拿内存视图覆盖别的进程刚写的键。
    const disk = { ...readPersisted() };
    for (const [k, e] of ENTRIES) {
      const sep = k.indexOf(":");
      const id = k.slice(0, sep) as ProviderId;
      const kind = k.slice(sep + 1) as HealthKind;
      const bucket = (disk[id] ??= {});
      if (e.cooldownUntil > 0) {
        bucket[kind] = {
          until: new Date(e.cooldownUntil).toISOString(),
          reason: e.reason ?? "",
          cooldownMs: e.cooldownMs,
        };
      } else {
        delete bucket[kind];
        if (!Object.keys(bucket).length) delete disk[id];
      }
    }
    await writeJsonAtomic(stateFile(), disk);
    fileCache = null;
  });
  const done = run.catch((error) => {
    log("warn", "provider 健康状态写盘失败", {
      msg: error instanceof Error ? error.message : String(error),
    });
  });
  persistQueue = done;
  return done;
}

// ── 判定 ────────────────────────────────────────────────────────────────

function inCooldown(e: Entry, now: number): boolean {
  return e.cooldownUntil > now;
}

/** 冷却已到期但还没被一次成功清零 = 半开。 */
function isHalfOpen(e: Entry, now: number): boolean {
  return e.cooldownMs > 0 && e.cooldownUntil <= now;
}

/**
 * 这家这条通道现在能不能进候选。冷却中 false；半开时若已有一个在途探路
 * （认领未超 5 分钟）也 false——探路任务一次只放一个。
 * 只读，无副作用；路由决定「就用这家」时再调 `claimProbe`。
 */
export function isAvailable(id: ProviderId, kind: HealthKind): boolean {
  const e = entry(id, kind);
  const now = Date.now();
  if (inCooldown(e, now)) return false;
  if (isHalfOpen(e, now) && e.halfOpenProbeAt > 0 && now - e.halfOpenProbeAt < PROBE_TTL_MS) {
    return false;
  }
  return true;
}

/** 路由选中一家处于半开态的 provider 时认领那个探路名额；非半开调用是 no-op。 */
export function claimProbe(id: ProviderId, kind: HealthKind): void {
  const e = entry(id, kind);
  if (isHalfOpen(e, Date.now())) e.halfOpenProbeAt = Date.now();
}

/**
 * 记一次调用结果。`code` 决定冷却档位；`retryAfterMs` 是上游 `Retry-After` 的
 * 毫秒数（`ProviderHttpError.retryAfterMs`），只对 `rate_limited` 生效。
 */
export function recordOutcome(
  id: ProviderId,
  kind: HealthKind,
  ok: boolean,
  ms: number,
  code?: string,
  opts?: { retryAfterMs?: number },
): void {
  const e = entry(id, kind);
  const now = Date.now();
  e.samples.push({ ts: now, ok, ms });
  e.samples = e.samples.filter((s) => now - s.ts <= WINDOW_MS).slice(-WINDOW_MAX);
  e.halfOpenProbeAt = 0;

  if (ok) {
    e.consecutiveTransient = 0;
    e.rateLimitStreak = 0;
    if (e.cooldownMs > 0 || e.cooldownUntil > 0) {
      e.cooldownUntil = 0;
      e.cooldownMs = 0;
      e.reason = undefined;
      void persist();
    }
    return;
  }

  if (code === "quota_exhausted") {
    void notifyAlert(
      "provider_exhausted",
      { providerId: id, kind, reason: "" },
      `provider_exhausted:${id}:${kind}`,
    );
    cooldown(id, kind, providerExhaustedTtlMs(), "quota_exhausted");
    return;
  }
  if (code === "rate_limited") {
    e.rateLimitStreak += 1;
    const hinted = opts?.retryAfterMs;
    const ms =
      hinted && Number.isFinite(hinted) && hinted > 0
        ? Math.min(hinted, COOLDOWN_MAX_MS)
        : Math.min(RATE_LIMIT_BASE_MS * 2 ** (e.rateLimitStreak - 1), COOLDOWN_MAX_MS);
    cooldown(id, kind, ms, "rate_limited");
    return;
  }
  if (isTransientCode(code)) {
    e.consecutiveTransient += 1;
    if (isHalfOpen(e, now)) {
      cooldown(id, kind, Math.min(Math.max(e.cooldownMs * 2, TRANSIENT_COOLDOWN_MS), COOLDOWN_MAX_MS), code ?? "transient");
      return;
    }
    if (e.consecutiveTransient >= TRANSIENT_TRIGGER) {
      void notifyAlert(
        "relay_unhealthy",
        { provider: id, kind, reason: code ?? "transient", cooldownMs: TRANSIENT_COOLDOWN_MS },
        `relay_unhealthy:${id}:${kind}`,
      );
      cooldown(id, kind, TRANSIENT_COOLDOWN_MS, code ?? "transient");
    }
  }
}

/** 5xx / 连接失败 / 读超时这一类「这家不稳」的判定；4xx 业务拒绝不算健康问题。 */
function isTransientCode(code: string | undefined): boolean {
  if (!code) return false;
  if (code === "upstream_timeout" || code === "upstream_unavailable") return true;
  if (code === "internal_error" || code === "service_unavailable" || code === "upstream_invalid_response") return true;
  return /^upstream_http_5\d\d$/.test(code);
}

/** 显式冷却；半开失败翻倍由 `recordOutcome` 走这里之前算好。 */
export function cooldown(id: ProviderId, kind: HealthKind, ms: number, reason: string): void {
  const e = entry(id, kind);
  e.cooldownUntil = Date.now() + ms;
  e.cooldownMs = ms;
  e.reason = String(reason ?? "").slice(0, 300);
  void persist();
}

/** 当前仍生效（冷却中或半开）或近期有样本的健康读数，给 `/api/health` 与管理接口。 */
export function healthList(): ProviderHealth[] {
  const now = Date.now();
  const out: ProviderHealth[] = [];
  const disk = readPersisted();
  const ids = new Set<string>([...ENTRIES.keys()].map((k) => k.slice(0, k.indexOf(":"))));
  for (const id of Object.keys(disk)) ids.add(id);
  for (const id of ids) {
    for (const kind of ["video", "image"] as const) {
      const e = ENTRIES.get(`${id}:${kind}`);
      const rec = disk[id]?.[kind];
      if (!e && !rec) continue;
      const cooldownUntil = e?.cooldownUntil ?? (rec ? Date.parse(rec.until) || 0 : 0);
      const cooldownMs = e?.cooldownMs ?? rec?.cooldownMs ?? 0;
      const inCool = cooldownUntil > now;
      const half = !inCool && cooldownMs > 0;
      if (!inCool && !half && !(e?.samples.length)) continue;
      const samples = e?.samples ?? [];
      out.push({
        providerId: id,
        kind,
        state: inCool ? "cooldown" : half ? "half-open" : "ok",
        until: inCool ? new Date(cooldownUntil).toISOString() : undefined,
        reason: inCool ? (e?.reason ?? rec?.reason) : undefined,
        recentSuccessRate: samples.length
          ? Math.round((samples.filter((s) => s.ok).length / samples.length) * 100) / 100
          : undefined,
      });
    }
  }
  return out;
}

/** 测试用：清掉全部内存状态与文件缓存（落盘文件本身由测试的临时 DATA_DIR 隔离）。 */
export function __resetHealthForTests(): void {
  ENTRIES.clear();
  fileCache = null;
}

/** 测试用：等异步落盘队列排空，避免和临时目录清理竞态。 */
export function __flushHealthForTests(): Promise<unknown> {
  return persistQueue;
}

// ── exhaustion.ts 兼容层 ────────────────────────────────────────────────

export async function markExhausted(
  providerId: ProviderId,
  kind: HealthKind,
  reason: string,
): Promise<void> {
  void notifyAlert(
    "provider_exhausted",
    { providerId, kind, reason: String(reason ?? "").slice(0, 300) },
    `provider_exhausted:${providerId}:${kind}`,
  );
  cooldown(providerId, kind, providerExhaustedTtlMs(), reason);
  await persistQueue;
}

/** 「已耗尽」= 冷却中。半开按可用算（探路名额由 isAvailable 把关）。 */
export function isExhausted(providerId: ProviderId, kind: HealthKind): boolean {
  const e = entry(providerId, kind);
  return e.cooldownUntil > Date.now();
}

/** 当前仍在冷却中的记录（旧 `data/provider-state.json` 读数的等价物）。 */
export function exhaustedList(): ExhaustionEntry[] {
  const now = Date.now();
  const out: ExhaustionEntry[] = [];
  const seen = new Set<string>();
  for (const [k, e] of ENTRIES) {
    if (e.cooldownUntil <= now) continue;
    const sep = k.indexOf(":");
    seen.add(k);
    out.push({
      providerId: k.slice(0, sep) as ProviderId,
      kind: k.slice(sep + 1) as HealthKind,
      until: new Date(e.cooldownUntil).toISOString(),
      reason: e.reason ?? "",
    });
  }
  for (const [id, byKind] of Object.entries(readPersisted())) {
    for (const kind of ["video", "image"] as const) {
      const rec = byKind?.[kind];
      if (!rec || seen.has(`${id}:${kind}`)) continue;
      const until = Date.parse(rec.until);
      if (!Number.isFinite(until) || until <= now) continue;
      out.push({ providerId: id as ProviderId, kind, until: rec.until, reason: rec.reason });
    }
  }
  return out;
}
