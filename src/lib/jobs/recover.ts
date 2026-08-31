import type { JobStatus } from "@/lib/jobs/schema";

export const JOB_STALE_MS = 15 * 60 * 1000;

export type RecoverDecision = "expire" | "requeue" | "resume-pending" | "keep";

export function recoverDecision(
  status: JobStatus,
  ageMs: number,
  hasRemoteId: boolean,
): RecoverDecision {
  if (status === "queued") return "requeue";
  const harnessActive =
    status === "directing" ||
    status === "keyframing" ||
    status === "generating_shots" ||
    status === "qc" ||
    status === "stitching";
  if (
    ageMs > JOB_STALE_MS &&
    (status === "submitting" ||
      status === "pending" ||
      status === "persisting" ||
      harnessActive)
  ) {
    return "expire";
  }
  if (status === "submitting" && !hasRemoteId) return "requeue";
  if (status === "submitting" && hasRemoteId) return "resume-pending";
  if (status === "pending" || status === "persisting" || harnessActive) return "keep";
  return "keep";
}
