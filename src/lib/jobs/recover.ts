import type { JobStatus } from "@/lib/jobs/schema";

export const JOB_STALE_MS = 15 * 60 * 1000;

export type RecoverDecision = "expire" | "requeue" | "resume-pending" | "uncertain" | "keep";

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
  // Deliberately ahead of the staleness check: age says nothing about whether the
  // upstream accepted the request. A crash between `provider.submit` returning and
  // the remote id reaching job.json leaves a possibly *paid* task behind, and both
  // ways out of it — re-queueing (a second POST) and expiring (which re-opens
  // one-click Retry) — can pay for the same clip twice. The honest answer is
  // "unknown", which the runner turns into failed/uncertain_submit (plan §3.2, G1).
  if (status === "submitting" && !hasRemoteId) return "uncertain";
  if (
    ageMs > JOB_STALE_MS &&
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
