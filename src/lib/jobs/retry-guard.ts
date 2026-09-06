import type { JobRecord } from "@/lib/jobs/schema";

/**
 * A shot recovered by `src/lib/harness/shot-recover.ts` carries this code when the crash
 * landed between `provider.submit` returning and the remote id reaching job.json: the
 * upstream may already hold a paid request. Kept as a literal here rather than imported
 * from the harness so the jobs layer does not depend on the harness module graph.
 */
export const UNCERTAIN_SUBMIT_CODE = "uncertain_submit";

/**
 * The job-level counterpart, written by the runner's crash recovery when a *single-clip*
 * job was interrupted the same way (plan §3.2, G1). Kept beside the code so the guard
 * below and the writer cannot drift apart on the wording the user reads.
 */
export const JOB_UNCERTAIN_SUBMIT_MESSAGE =
  "任务中断在提交后、远端 id 落盘前，上游可能已接单，为避免重复计费不再自动重试";

/**
 * Retention purged this job's `inputs/` (plan §8), so a one-click retry has
 * nothing to copy: an image-to-video retry would silently become text-to-video,
 * and the harness would re-pay for shots whose clips are gone. The way forward is
 * a fresh submission with the same prompt, which the works view offers.
 */
export const ARTIFACTS_PURGED_CODE = "artifacts_purged";

export type PurgedBlock = {
  code: typeof ARTIFACTS_PURGED_CODE;
  message: string;
};

/** Why a purged job may not be retried, or null. Checked before anything else. */
export function purgedBlock(rec: Pick<JobRecord, "artifactsPurgedAt">): PurgedBlock | null {
  if (!rec.artifactsPurgedAt) return null;
  return {
    code: ARTIFACTS_PURGED_CODE,
    message: "作品已过期清理，请用这条提示词重新生成",
  };
}

export type RetryBlock = {
  code: "uncertain_submit";
  message: string;
  /**
   * Ascending shot indexes (0-based) that carry the uncertain-submit marker; empty when
   * the marker is job-level (a single-clip job has no shots to point at).
   */
  shotIndexes: number[];
};

/**
 * One-click Retry re-queues every non-succeeded shot at `costUsd: 0`, i.e. it pays again.
 * With an uncertain submit on the books that could pay twice for work the upstream already
 * accepted, so the retry is refused until a human has checked the upstream ledger. There is
 * deliberately no override: the way forward is to verify upstream and submit a new job.
 *
 * Two sources of the marker, both meaning "the upstream may already hold a paid request":
 *  - per-shot, written by the harness's own shot recovery — the message names the shots;
 *  - job-level `error.code`, written by `runner.recover()` for a single-clip job that
 *    crashed between `provider.submit` returning and `remoteId` reaching job.json.
 *
 * The per-shot check runs first so a harness job keeps the more specific message.
 */
export function retryBlock(rec: Pick<JobRecord, "harnessShots" | "error">): RetryBlock | null {
  const shots = rec.harnessShots;
  const shotIndexes = (shots ?? [])
    .filter((shot) => shot.error?.code === UNCERTAIN_SUBMIT_CODE)
    .map((shot) => shot.index)
    .sort((a, b) => a - b);

  if (shotIndexes.length > 0) {
    const which = shotIndexes.map((index) => `第 ${index + 1} 镜`).join("、");
    return {
      code: "uncertain_submit",
      message:
        `${which}中断在提交后、远端 id 落盘前，上游可能已接单。` +
        `请先在 xAI 控制台核对该请求是否已计费，再重新提交新任务；一键重做已禁用以免重复付费。`,
      shotIndexes,
    };
  }

  if (rec.error?.code === UNCERTAIN_SUBMIT_CODE) {
    // No shot indexes to name: the whole job is the uncertain unit.
    return { code: "uncertain_submit", message: JOB_UNCERTAIN_SUBMIT_MESSAGE, shotIndexes: [] };
  }
  return null;
}
