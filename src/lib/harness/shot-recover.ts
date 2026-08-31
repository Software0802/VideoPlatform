import { harnessShotRecordSchema, type HarnessShotRecord, type HarnessShotStatus } from "./shot-state";

export type ShotRecoverDecision = "keep" | "requeue" | "resume-pending" | "resume-persisting";

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
  if (status === "submitting" || status === "pending") {
    return hasRemoteId ? "resume-pending" : "requeue";
  }
  if (status === "persisting") {
    return hasRemoteId ? "resume-persisting" : "requeue";
  }
  return "keep";
}

export function recoverHarnessShot(record: HarnessShotRecord): HarnessShotRecord {
  const decision = recoverShotDecision(record.status, Boolean(record.remoteId));
  if (decision === "keep") return { ...record };
  if (decision === "requeue") {
    return harnessShotRecordSchema.parse({
      id: record.id,
      index: record.index,
      status: "queued",
      retries: record.retries,
      costUsd: record.costUsd,
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
