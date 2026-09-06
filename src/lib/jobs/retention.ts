import { dataRetentionDays } from "@/lib/env";
import { purgeJobArtifacts } from "@/lib/jobs/local-output";
import { isTerminalStatus, type JobRecord } from "@/lib/jobs/schema";
import { listJobRecords, tmpDir, updateJob } from "@/lib/jobs/store";
import { mediaStore } from "@/lib/storage/local-fs";
import { log } from "@/lib/log";

/**
 * Artifact retention (plan §8).
 *
 * The rule is deliberately *not* a status transition: `succeeded` / `failed` /
 * `canceled` / `expired` have no outgoing edges in `state-machine.ts`, so an
 * `expired`-style "purged" status could never be reached. Retention is a second
 * axis — the record keeps its terminal status and gains `artifactsPurgedAt`,
 * while `inputs/` and `outputs/` are deleted from disk.
 *
 * A job is purged when it is terminal and settled longer ago than
 * `DATA_RETENTION_DAYS`. Non-terminal jobs are never touched: one of them may be
 * mid-`persisting` and about to write the very file this would delete.
 */

const DAY_MS = 86_400_000;

/** The fields the rule needs — `JobRecord` satisfies it, tests can pass literals. */
export type RetentionJob = Pick<JobRecord, "id" | "status" | "updatedAt"> & {
  completedAt?: string;
  artifactsPurgedAt?: string;
};

export type RetentionResult = {
  /** Terminal + expired + not already purged. */
  purged: number;
  /** Records the sweep could not finish; each was logged and the round went on. */
  failed: number;
};

/**
 * Which instant decides the job's age. Identical to the quota's `settledAtMs`
 * (`completedAt ?? updatedAt`) on purpose: the two must agree on when a job
 * finished, or a record could be purged on one clock and billed on another.
 */
function settledAtMs(job: RetentionJob): number | null {
  const ms = Date.parse(job.completedAt ?? job.updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure decision, `nowMs` injected so the boundary is testable without waiting a
 * month. `retentionDays <= 0` disables retention entirely (plan §8).
 */
export function shouldPurgeArtifacts(
  job: RetentionJob,
  nowMs: number,
  retentionDays: number,
): boolean {
  if (retentionDays <= 0) return false;
  if (job.artifactsPurgedAt) return false;
  if (!isTerminalStatus(job.status)) return false;
  const settled = settledAtMs(job);
  if (settled === null) return false;
  return nowMs - settled >= retentionDays * DAY_MS;
}

/**
 * Delete the artifacts of every expired job and stamp the records.
 *
 * Runs inside the job runner's hourly maintenance tick, i.e. in the same process
 * that writes `job.json`, so the stamp goes through `store.updateJob` and takes
 * that job's lock rather than replacing the file behind a live writer.
 *
 * The bytes go first and the stamp second: a crash in between leaves a record
 * that still looks unpurged, and the next sweep redoes a delete that is already
 * idempotent. The other order would advertise "已清理" over files still on disk.
 *
 * One unusable record (a hand-edited or half-written `job.json`) is logged at
 * `warn` and skipped — it must not stop the rest of the round.
 */
export async function sweepRetention(
  opts: { nowMs?: number; retentionDays?: number } = {},
): Promise<RetentionResult> {
  const retentionDays = opts.retentionDays ?? dataRetentionDays();
  const result: RetentionResult = { purged: 0, failed: 0 };
  if (retentionDays <= 0) return result;

  const nowMs = opts.nowMs ?? Date.now();
  const stamp = new Date(nowMs).toISOString();
  const jobs = await listJobRecords();
  for (const job of jobs) {
    if (!shouldPurgeArtifacts(job, nowMs, retentionDays)) continue;
    try {
      await purgeJobArtifacts(mediaStore.jobDir(job.id), tmpDir(), job.id);
      await updateJob(job.id, (rec) => {
        // Legacy back-fill, and it must happen on *every* write this sweep makes.
        // `updateJob` refreshes `updatedAt`, and the quota reads a settle day of
        // `completedAt ?? updatedAt` — so touching a pre-`completedAt` record
        // without pinning its finish time first would move a month-old job into
        // today's quota. `stampCompletedAt` cannot do it for us: it only fires on
        // the non-terminal → terminal edge, which this job crossed long ago.
        if (!rec.completedAt) rec.completedAt = rec.updatedAt;
        if (!rec.artifactsPurgedAt) rec.artifactsPurgedAt = stamp;
        return rec;
      });
      result.purged += 1;
    } catch (error) {
      result.failed += 1;
      log("warn", "retention purge failed", {
        id: job.id,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (result.purged || result.failed) {
    log("info", "sweepRetention", { ...result, retentionDays });
  }
  return result;
}
