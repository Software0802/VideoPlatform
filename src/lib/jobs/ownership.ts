import { adminUserId } from "@/lib/env";

/**
 * Who may see a job (plan §4 / §5.1). Kept in one place because five routes
 * (`GET /api/jobs`, `GET /api/jobs/:id`, `/events`, `/cancel`, `/retry`,
 * `/api/media/:jobId/:file`) and the SSR home page must all answer it the same
 * way; any of them getting it wrong is a data leak.
 */

/** True only when `LUMEN_ADMIN_USER_ID` is set and names this user. */
export function isAdminUser(userId: string): boolean {
  const admin = adminUserId();
  return Boolean(admin) && admin === userId;
}

/**
 * Jobs written before the user system have no `ownerId`. They stay invisible to
 * everyone except the configured administrator — with no administrator
 * configured, to nobody at all.
 */
export function canAccessJob(job: { ownerId?: string }, userId: string): boolean {
  if (job.ownerId) return job.ownerId === userId;
  return isAdminUser(userId);
}
