import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir, providerExhaustedTtlMs } from "@/lib/env";
import { log } from "@/lib/log";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import type { ProviderId } from "@/lib/providers/types";

/**
 * 「这家上游的积分用光了」这一条事实，按 provider × 通道分开记。
 *
 * 视频与图片常常是两个额度池（YMan 的视频按积分、生图按人民币档），一条耗尽不该把
 * 另一条也拉黑，所以键是 `provider + kind` 而不是光 provider。
 */
export type ExhaustionKind = "video" | "image";

export type ExhaustionEntry = {
  providerId: ProviderId;
  kind: ExhaustionKind;
  /** ISO 时间，过了就自动重新参与路由。 */
  until: string;
  /** 上游当时说了什么（`ProviderHttpError.message`），排查时不用去翻日志。 */
  reason: string;
};

type StateFile = Partial<Record<string, Partial<Record<ExhaustionKind, { until: string; reason: string }>>>>;

/** `data/provider-state.json`：与任务记录同目录树，跟着 `DATA_DIR` 走（隔离的 e2e 也就隔离了）。 */
function stateFile(): string {
  return path.join(dataDir(), "provider-state.json");
}

/**
 * 进程内缓存 + mtime 校验。
 *
 * 校验而不是纯缓存：runner 与页面 / health 可能在不同进程里（`next start` 多实例、
 * 脚本），只信自己这一份会让「已经切走了」在另一个进程里看不见。`statSync` 很便宜，
 * 而这个文件只有几行。
 */
let cache: { path: string; mtimeMs: number; state: StateFile } | null = null;

function readState(): StateFile {
  const file = stateFile();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // 文件还不存在（最常见的情况）：空状态，且不缓存——它随时会被创建出来。
    cache = null;
    return {};
  }
  if (cache && cache.path === file && cache.mtimeMs === mtimeMs) return cache.state;
  let state: StateFile = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as StateFile;
  } catch {
    // 手改坏了 / 写到一半被读到：当成没有耗尽记录，最坏结果是多打一次上游而已。
    state = {};
  }
  cache = { path: file, mtimeMs, state };
  return state;
}

/**
 * 记下「这家这条通道积分耗尽」，`PROVIDER_EXHAUSTED_TTL_MS`（默认 6 小时）后自动解除。
 *
 * 写盘而不是只放内存：runner 崩溃重启后不该又把下一批任务全撞到同一家已经没钱的上游上。
 * 写失败只记一条 warn——切换本身是尽力而为的优化，不能因为写不了状态文件就把任务打挂。
 */
export async function markExhausted(
  providerId: ProviderId,
  kind: ExhaustionKind,
  reason: string,
): Promise<void> {
  const until = new Date(Date.now() + providerExhaustedTtlMs()).toISOString();
  const state = { ...readState() };
  state[providerId] = { ...state[providerId], [kind]: { until, reason: String(reason ?? "").slice(0, 300) } };
  try {
    await writeJsonAtomic(stateFile(), state);
    // 自己刚写的那份直接失效，下次读按 mtime 重新载入。
    cache = null;
  } catch (error) {
    log("warn", "provider 耗尽状态写盘失败", {
      providerId,
      kind,
      msg: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 这家这条通道现在是不是还在「已耗尽」窗口里。同步——路由是同步的。 */
export function isExhausted(providerId: ProviderId, kind: ExhaustionKind): boolean {
  const entry = readState()[providerId]?.[kind];
  if (!entry) return false;
  const until = Date.parse(entry.until);
  return Number.isFinite(until) && until > Date.now();
}

/** 当前仍在生效的耗尽记录，给 `/api/health` 用。过期的不出现（它们已经不影响路由了）。 */
export function exhaustedList(): ExhaustionEntry[] {
  const out: ExhaustionEntry[] = [];
  const now = Date.now();
  for (const [providerId, byKind] of Object.entries(readState())) {
    for (const kind of ["video", "image"] as const) {
      const entry = byKind?.[kind];
      if (!entry) continue;
      const until = Date.parse(entry.until);
      if (!Number.isFinite(until) || until <= now) continue;
      out.push({
        providerId: providerId as ProviderId,
        kind,
        until: entry.until,
        reason: entry.reason,
      });
    }
  }
  return out;
}
