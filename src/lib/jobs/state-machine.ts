import type { JobStatus } from "@/lib/jobs/schema";

const ALLOWED: Record<JobStatus, JobStatus[]> = {
  queued: ["submitting", "directing", "canceled"],
  // `queued` is the backoff edge: an upstream that refused the submit (rate limit,
  // platform balance) never billed it, so the job goes back in line with a delay
  // instead of dying. It is the only backwards edge in the table.
  submitting: ["queued", "pending", "persisting", "failed", "canceled"],
  pending: ["persisting", "failed", "expired", "canceled"],
  persisting: ["succeeded", "failed", "canceled"],
  directing: ["keyframing", "failed", "canceled"],
  keyframing: ["generating_shots", "failed", "canceled"],
  generating_shots: ["qc", "failed", "canceled"],
  qc: ["stitching", "generating_shots", "failed", "canceled"],
  stitching: ["persisting", "succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  expired: [],
  canceled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function canCancel(status: JobStatus): boolean {
  return canTransition(status, "canceled");
}

export function assertTransition(from: JobStatus, to: JobStatus) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal transition ${from} -> ${to}`);
  }
}
