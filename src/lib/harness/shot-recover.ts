import { harnessShotRecordSchema, type HarnessShotRecord, type HarnessShotStatus } from "./shot-state";

export type ShotRecoverDecision =
  | "keep"
  | "requeue"
  | "resume-pending"
  | "resume-persisting"
  /** Possibly already submitted upstream: a blind re-submit could pay twice (R-P1-3). */
  | "review";

export const UNCERTAIN_SUBMIT_MESSAGE =
  "中断发生在提交后、远端 id 落盘前，上游可能已接单；请人工核对后再重做";

export function recoverShotDecision(
  status: HarnessShotStatus,
  hasRemoteId: boolean,
): ShotRecoverDecision {
  if (
    status === "queued" ||
    status === "failed" ||
    status === "succeeded" ||
    status === "needs_review" ||
    status === "canceled"
  ) {
    return "keep";
  }
  if (status === "submitting") {
    // The crash window sits between `provider.submit` returning and the remote id
    // reaching job.json, so the upstream may already hold a paid request. Requeuing
    // would both double-charge and break the concurrency cap; a human decides instead.
    return hasRemoteId ? "resume-pending" : "review";
  }
  if (status === "pending") {
    return hasRemoteId ? "resume-pending" : "requeue";
  }
  if (status === "persisting") {
    // Reached only via a synchronous provider result that was lost with the process:
    // nothing was ever handed to a queue, so re-submitting is safe.
    return hasRemoteId ? "resume-persisting" : "requeue";
  }
  return "keep";
}

export function recoverHarnessShot(record: HarnessShotRecord): HarnessShotRecord {
  const decision = recoverShotDecision(record.status, Boolean(record.remoteId));
  if (decision === "keep") return { ...record };
  if (decision === "review") {
    return harnessShotRecordSchema.parse({
      ...record,
      status: "needs_review",
      error: { code: "uncertain_submit", message: UNCERTAIN_SUBMIT_MESSAGE },
    });
  }
  if (decision === "requeue") {
    // Money already booked by earlier attempts must survive the restart, or the next
    // attempt would overwrite the ledger with its own charge alone (R-P1-3).
    return harnessShotRecordSchema.parse({
      id: record.id,
      index: record.index,
      status: "queued",
      retries: record.retries,
      costUsd: record.costUsd,
      // A synchronous provider may have booked this attempt's charge (costUsd > 0) without
      // ever setting priorCostUsd; the re-submit must add on top of it, never overwrite it.
      ...(Math.max(record.costUsd, record.priorCostUsd ?? 0) > 0
        ? { priorCostUsd: Math.max(record.costUsd, record.priorCostUsd ?? 0) }
        : {}),
      ...(record.costUnknown === undefined ? {} : { costUnknown: record.costUnknown }),
    });
  }
  if (decision === "resume-pending") {
    return harnessShotRecordSchema.parse({ ...record, status: "pending" });
  }
  return harnessShotRecordSchema.parse({ ...record, status: "persisting" });
}

export function recoverHarnessShots(records: readonly HarnessShotRecord[]): HarnessShotRecord[] {
  return records.map(recoverHarnessShot);
}
