import { emitJob } from "@/lib/jobs/events";
import type { JobRecord } from "@/lib/jobs/schema";
import { canTransition } from "@/lib/jobs/state-machine";
import { readJob, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { deleteXaiFile } from "@/lib/providers/grok/client";
import { ProviderHttpError } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { cleanupJobArtifacts } from "../local-output";

export type RunnerState = {
  started: boolean;
  inflight: Set<string>;
  /**
   * 待办集合：可能还需要跑的任务 id（方案 §3.3）。
   *
   * 在它之前 `pump()` 每次被叫醒都要把全站 job.json 读一遍去找那几条待跑的——历史任务
   * 越多，每次状态推进就越慢，而待跑的从来只有个位数。现在入队时加进来、跑到终态时摘
   * 掉，`pump` 只读集合里这几条。集合是进程内状态，崩溃后由启动时的索引重新灌满。
   */
  todo: Set<string>;
  timer?: NodeJS.Timeout;
  /** Wakes `pump()` when the earliest backed-off job becomes eligible again. */
  backoffTimer?: NodeJS.Timeout;
  /** 冷启动时延后跑的第一次维护（见 `startJobRunner`）。 */
  maintenanceTimer?: NodeJS.Timeout;
};

export function state(): RunnerState {
  const g = globalThis as typeof globalThis & { __lumenRunner?: RunnerState };
  if (!g.__lumenRunner) {
    g.__lumenRunner = { started: false, inflight: new Set(), todo: new Set() };
  }
  return g.__lumenRunner;
}

/**
 * Upstream refusals that are nobody's fault and pass on their own: the account is out
 * of credit, or the platform's concurrency ceiling is full right now. Failing the job
 * outright would show "失败" for what is really "排队", and — because a submit that was
 * refused was never billed — retrying it costs nothing but time.
 */
export const UPSTREAM_BACKOFF_CODES: ReadonlySet<string> = new Set(["rate_limited", "quota_exhausted"]);
export const MAX_UPSTREAM_RETRIES = 3;
export const UPSTREAM_BACKOFF_BASE_MS = 15_000;

/** User-facing wording for a refusal that survived every retry; upstream text goes to `detail`. */
export function upstreamFailure(error: ProviderHttpError): { message: string; detail: string } {
  const message =
    error.code === "quota_exhausted"
      ? "平台余额不足，请联系管理员"
      : `上游繁忙，已重试 ${MAX_UPSTREAM_RETRIES} 次仍失败，请稍后再试`;
  return { message, detail: error.message };
}

/**
 * Re-arm the wake-up for backed-off jobs. Called on every pump so the timer always
 * tracks the *earliest* deadline currently on disk; `unref` keeps it from holding a
 * short-lived process (tests, scripts) open.
 *
 * `wake` 即 `pump`，由入口传入——本模块被入口引用，反向 import 会成环。
 */
export function scheduleBackoffPump(s: RunnerState, atMs: number, wake: () => void) {
  if (s.backoffTimer) {
    clearTimeout(s.backoffTimer);
    s.backoffTimer = undefined;
  }
  if (!Number.isFinite(atMs)) return;
  // Cap the sleep so a corrupt far-future timestamp cannot park the queue forever.
  const delay = Math.min(Math.max(atMs - Date.now(), 50), 5 * 60_000);
  s.backoffTimer = setTimeout(() => {
    s.backoffTimer = undefined;
    void wake();
  }, delay);
  s.backoffTimer.unref();
}

export async function transition(id: string, to: JobRecord["status"]) {
  const rec = await updateJob(id, (r) => {
    if (!canTransition(r.status, to) && r.status !== to) {
      throw new Error(`illegal ${r.status} -> ${to}`);
    }
    r.status = to;
    return r;
  });
  emitRec(rec);
  return rec;
}

export async function fail(id: string, code: string, message: string, detail?: string) {
  const rec = await readJob(id);
  if (
    !rec ||
    rec.canceled ||
    ["succeeded", "failed", "expired", "canceled"].includes(rec.status)
  ) {
    return;
  }
  if (rec?.localOutputPath) await removeLocalOutput(id, rec.localOutputPath);
  if (rec?.assets.source?.xaiFileId) {
    void deleteXaiFile(rec.assets.source.xaiFileId);
  }
  const next = await updateJob(id, (r) => {
    if (["succeeded", "failed", "expired", "canceled"].includes(r.status) || r.canceled) return r;
    r.status = code === "expired" ? "expired" : "failed";
    r.error = detail ? { code, message, detail } : { code, message };
    return r;
  });
  emitRec(next);
}

export function emitRec(rec: JobRecord) {
  emitJob(toPublic(rec));
  return rec;
}

export async function removeLocalOutput(jobId: string, relativePath?: string) {
  await cleanupJobArtifacts(mediaStore.jobDir(jobId), tmpDir(), jobId, relativePath);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
