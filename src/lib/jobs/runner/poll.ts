import { upstreamPollMaxMs, upstreamRetryBaseMs } from "@/lib/env";
import { readJob, updateJob } from "@/lib/jobs/store";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import { recordOutcome } from "@/lib/providers/health";
import { providerForId } from "@/lib/providers/router";
import {
  ProviderHttpError,
  type ProviderId,
  type VideoProvider,
} from "@/lib/providers/types";
import { emitRec, fail, sleep } from "./state";

/**
 * 一条任务在本地最多等多久（方案 §2 G6）。
 *
 * 曾经是 `pollUntilDone` 里的一个 15 分钟字面量，兼当 recover 的陈旧判定，于是
 * `klingTaskTimeoutMs()` 配了也没人读。现在由 provider 自己声明
 * （`capabilities().taskTimeoutMs`），没声明的按 15 分钟——grok / mock 就走这条。
 *
 * 认不出的 provider id（历史记录里出现过、现在已经删掉的那家）不该让恢复流程整个抛，
 * 按默认值处理。
 */
export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;

export function taskTimeoutMsFor(providerId: ProviderId): number {
  try {
    return providerForId(providerId).capabilities().taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  } catch {
    return DEFAULT_TASK_TIMEOUT_MS;
  }
}

/**
 * 本地放弃等待时说的话。
 *
 * 不能只说「超时」：超时的是**我们**，上游那边任务多半还活着，而且提交的那一刻就已经
 * 计费了。用户据此决定是去上游查收，还是重开一单——「失败」两个字会让他直接重开，
 * 于是同一条片子付两次钱。
 */
export const LOCAL_GIVE_UP_MESSAGE =
  "等待超时：本地已放弃等待，上游可能仍在出片并已计费，请先确认再决定是否重新生成";

/** 轮询阶梯（方案 §3.3「轮询」）：前 20 秒 2s，20→60 秒线性升到 5s，之后到上限。 */
const POLL_BASE_MS = 2_000;
const POLL_MID_MS = 5_000;
const POLL_RAMP_START_MS = 20_000;
const POLL_RAMP_END_MS = 60_000;

/**
 * 距离开始轮询 `elapsedMs` 时，下一次该等多久。
 *
 * 固定 2 秒对一条 5 分钟的可灵任务意味着 150 次 HTTP + 150 次写盘 + 150 次 SSE 广播，
 * 而其中有意义的只有最后一次。阶梯的形状迁就的是「用户还在看着」的那前 20 秒：那时反馈
 * 要快；之后他多半已经切走了，慢一点没人察觉。上限 `UPSTREAM_POLL_MAX_MS` 可调，调到
 * 比 2 秒还小时全程按它走（不给一个「最短也要 2 秒」的隐藏下限）。
 */
export function pollDelayMs(elapsedMs: number, maxMs: number = upstreamPollMaxMs()): number {
  let raw: number;
  if (elapsedMs < POLL_RAMP_START_MS) {
    raw = POLL_BASE_MS;
  } else if (elapsedMs < POLL_RAMP_END_MS) {
    const ratio = (elapsedMs - POLL_RAMP_START_MS) / (POLL_RAMP_END_MS - POLL_RAMP_START_MS);
    raw = POLL_BASE_MS + (POLL_MID_MS - POLL_BASE_MS) * ratio;
  } else {
    raw = maxMs;
  }
  return Math.round(Math.min(raw, maxMs));
}

export async function pollUntilDone(id: string) {
  const first = await readJob(id);
  if (!first || first.status === "canceled") return;
  // 总上限按这条任务的 provider 取一次（方案 §2 G6）。中途换家的路径不会走到这儿——
  // `switchAwayFromExhausted` 把任务打回 `queued`，下一轮重新进这个函数。
  const timeoutMs = taskTimeoutMsFor(first.provider);
  const started = Date.now();
  let transientRetries = 0;
  while (Date.now() - started < timeoutMs) {
    const job = await readJob(id);
    if (!job || job.status === "canceled") return;
    const provider = providerForId(job.provider);
    const kind = isImageMode(job.mode) ? "image" : "video";
    let poll: Awaited<ReturnType<typeof provider.poll>>;
    const pollStarted = Date.now();
    try {
      poll = await provider.poll({
        providerId: provider.id,
        remoteId: job.remoteId,
        localVideoPath: "outputs/video.mp4",
      });
    } catch (error) {
      // 轮询的 5xx / 超时同样计入健康窗口（连续 3 次触发 5 分钟冷却）；
      // 但单子已经在上游手里——无论计不计健康都绝不重发，任务照旧走失败退款。
      recordOutcome(
        provider.id,
        kind,
        false,
        Date.now() - pollStarted,
        error instanceof ProviderHttpError ? error.code : undefined,
      );
      if (!isRetryablePollError(error) || transientRetries >= 2) throw error;
      transientRetries += 1;
      await sleep(upstreamRetryBaseMs() * 2 ** (transientRetries - 1));
      continue;
    }
    if (isRetryablePollResult(poll)) {
      if (transientRetries >= 2) {
        // Let the normal failed path preserve the upstream code/message.
      } else {
        transientRetries += 1;
        await sleep(upstreamRetryBaseMs() * 2 ** (transientRetries - 1));
        continue;
      }
    } else {
      // A successful pending response breaks a transient-error streak.
      transientRetries = 0;
    }
    const again = await readJob(id);
    if (
      !again ||
      again.status === "canceled" ||
      again.canceled ||
      ["succeeded", "failed", "expired"].includes(again.status)
    ) {
      return;
    }
    if (poll.status === "pending") {
      // 进度没动就不写盘、不广播（方案 §3.3「轮询」）。一条 5 分钟的任务上游多半只报
      // 几次进度，其余几十次轮询是一模一样的答复，为它们重写 job.json 再走一遍 SSE
      // 只是在 2 核机上白烧 IO 和事件循环。状态还不是 `pending`（刚从 submitting 过来）
      // 时仍要写：那一次是真的有变化。
      const unchanged =
        again.status === "pending" && Math.max(again.progress, poll.progress) === again.progress;
      if (!unchanged) {
        await updateJob(id, (r) => {
          if (r.status === "canceled" || r.canceled) return r;
          r.progress = Math.max(r.progress, poll.progress);
          r.status = "pending";
          return r;
        }).then(emitRec);
      }
      await sleep(pollDelayMs(Date.now() - started));
      continue;
    }
    if (poll.status === "expired") {
      await updateJob(id, (r) => {
        r.status = "expired";
        r.error = { code: "expired", message: "生成任务已过期" };
        return r;
      }).then(emitRec);
      return;
    }
    if (poll.status === "failed" || poll.respectModeration === false) {
      // 上游给出明确的任务级失败：单子已被受理并跑完（或被判失败），没有「再提交一次」
      // 的选项——计入健康窗口（失败率统计），任务按现有失败路径退款。
      recordOutcome(provider.id, kind, false, Date.now() - pollStarted, poll.errorCode);
      await fail(
        id,
        poll.errorCode ?? "failed",
        poll.respectModeration === false ? "未通过安全审核" : (poll.errorMessage ?? "生成失败"),
      );
      return;
    }
    recordOutcome(provider.id, kind, true, Date.now() - pollStarted);
    await updateJob(id, (r) => {
      if (r.status === "canceled" || r.canceled) return r;
      r.status = "persisting";
      r.progress = 90;
      r.remoteUrl = poll.remoteUrl;
      r.fileOutputId = poll.fileOutputId ?? r.fileOutputId;
      r.costUsdActual = poll.usage?.costUsdActual ?? r.costUsdActual;
      return r;
    }).then(emitRec);
    return;
  }
  await fail(id, "timeout", LOCAL_GIVE_UP_MESSAGE);
}

const RETRYABLE_POLL_CODES = new Set([
  "service_unavailable",
  "internal_error",
  "upstream_unavailable",
  "upstream_timeout",
]);

export function isRetryablePollError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.code === "invalid_argument") return false;
  return error.status === 429 || error.status >= 500 || RETRYABLE_POLL_CODES.has(error.code);
}

export function isRetryablePollResult(poll: Awaited<ReturnType<VideoProvider["poll"]>>): boolean {
  return poll.status === "failed" && Boolean(poll.errorCode && RETRYABLE_POLL_CODES.has(poll.errorCode));
}
