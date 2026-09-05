import type { JobRecord } from "@/lib/jobs/schema";

/**
 * A shot recovered by `src/lib/harness/shot-recover.ts` carries this code when the crash
 * landed between `provider.submit` returning and the remote id reaching job.json: the
 * upstream may already hold a paid request. Kept as a literal here rather than imported
 * from the harness so the jobs layer does not depend on the harness module graph.
 */
export const UNCERTAIN_SUBMIT_CODE = "uncertain_submit";

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
