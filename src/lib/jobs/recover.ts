import type { JobStatus } from "@/lib/jobs/schema";

/**
 * 陈旧判定的默认阈值。
 *
 * **不再是唯一的阈值**：真正用的是「这条任务所属 provider 的轮询上限 + 5 分钟」
 * （`runner.taskTimeoutMsFor`，方案 §2 G6）——一家慢上游的正常任务不该因为本地写死的
 * 15 分钟就被判「过期」，那等于付了钱却告诉用户失败了。这里留作默认值，给没有 provider
 * 上下文的调用方（和这个纯函数自己的测试）。
 */
export const JOB_STALE_MS = 15 * 60 * 1000;

export type RecoverDecision = "expire" | "requeue" | "resume-pending" | "uncertain" | "keep";

export function recoverDecision(
  status: JobStatus,
  ageMs: number,
  hasRemoteId: boolean,
  staleMs: number = JOB_STALE_MS,
): RecoverDecision {
  if (status === "queued") return "requeue";
  const harnessActive =
    status === "directing" ||
    status === "keyframing" ||
    status === "generating_shots" ||
    status === "qc" ||
    status === "stitching";
  // Deliberately ahead of the staleness check: age says nothing about whether the
  // upstream accepted the request. A crash between `provider.submit` returning and
  // the remote id reaching job.json leaves a possibly *paid* task behind, and both
  // ways out of it — re-queueing (a second POST) and expiring (which re-opens
  // one-click Retry) — can pay for the same clip twice. The honest answer is
  // "unknown", which the runner turns into failed/uncertain_submit (plan §3.2, G1).
  if (status === "submitting" && !hasRemoteId) return "uncertain";
  if (
    ageMs > staleMs &&
    (status === "submitting" ||
      status === "pending" ||
      status === "persisting" ||
      harnessActive)
  ) {
    return "expire";
  }
  if (status === "submitting" && hasRemoteId) return "resume-pending";
  if (status === "pending" || status === "persisting" || harnessActive) return "keep";
  return "keep";
}
