import type { JobRecord } from "@/lib/jobs/schema";

/**
 * A shot recovered by `src/lib/harness/shot-recover.ts` carries this code when the crash
 * landed between `provider.submit` returning and the remote id reaching job.json: the
 * upstream may already hold a paid request. Kept as a literal here rather than imported
 * from the harness so the jobs layer does not depend on the harness module graph.
 */
export const UNCERTAIN_SUBMIT_CODE = "uncertain_submit";

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
  /** Ascending shot indexes (0-based) that carry the uncertain-submit marker. */
  shotIndexes: number[];
};

/**
 * One-click Retry re-queues every non-succeeded shot at `costUsd: 0`, i.e. it pays again.
 * With an uncertain submit on the books that could pay twice for work the upstream already
 * accepted, so the retry is refused until a human has checked the upstream ledger. There is
 * deliberately no override: the way forward is to verify upstream and submit a new job.
 *
 * Only per-shot markers count; a job-level error code is never enough to block.
 */
export function retryBlock(rec: Pick<JobRecord, "harnessShots">): RetryBlock | null {
  const shots = rec.harnessShots;
  if (!shots || shots.length === 0) return null;

  const shotIndexes = shots
    .filter((shot) => shot.error?.code === UNCERTAIN_SUBMIT_CODE)
    .map((shot) => shot.index)
    .sort((a, b) => a - b);
  if (shotIndexes.length === 0) return null;

  const which = shotIndexes.map((index) => `第 ${index + 1} 镜`).join("、");
  return {
    code: "uncertain_submit",
    message:
      `${which}中断在提交后、远端 id 落盘前，上游可能已接单。` +
      `请先在 xAI 控制台核对该请求是否已计费，再重新提交新任务；一键重做已禁用以免重复付费。`,
    shotIndexes,
  };
}
