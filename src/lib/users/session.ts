import { readUser } from "@/lib/users/store";
import type { UserRecord } from "@/lib/users/schema";
import {
  issueSessionValue,
  readSessionCookie,
  requestUsesHttps,
  serializeSessionCookie,
  verifySessionValue,
} from "@/lib/users/session-token";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * Session resolution that reads `data/users/<id>/user.json`. Route handlers use
 * this; `src/proxy.ts` must not (it only verifies the signature — see
 * `session-token.ts`).
 */

export * from "@/lib/users/session-token";

/**
 * Resolve the caller. Every request re-reads `user.json`, which is what makes a
 * ban (`disabled`) and a password change (`sessionEpoch`) take effect
 * immediately without a server-side session table (plan §3).
 */
export async function sessionUser(
  request: Request,
  nowMs: number = Date.now(),
): Promise<UserRecord | null> {
  return sessionUserFromValue(readSessionCookie(request), nowMs);
}

/**
 * Same check, starting from the raw cookie value. Server components read the
 * cookie through `next/headers` rather than a `Request`, so they call this.
 */
export async function sessionUserFromValue(
  value: string | undefined,
  nowMs: number = Date.now(),
): Promise<UserRecord | null> {
  if (!value) return null;
  const claims = verifySessionValue(value, nowMs);
  if (!claims) return null;
  const user = await readUser(claims.userId);
  if (!user || user.disabled) return null;
  if (user.sessionEpoch !== claims.epoch) return null;
  return user;
}

/**
 * The one gate every protected route handler goes through. The proxy already
 * rejected unsigned / expired cookies, but a valid signature is not enough:
 * only this check sees `disabled` and `sessionEpoch`, and Next explicitly warns
 * that proxy coverage can be lost by a matcher or routing change, so
 * authorization has to be re-established inside the handler.
 */
export async function requireUser(request: Request): Promise<UserRecord> {
  const user = await sessionUser(request);
  if (!user) throw new ProviderHttpError(401, "unauthorized", "请先登录");
  return user;
}

/** Convenience for the auth routes: fresh cookie for a freshly authenticated user. */
export function issueSessionCookie(user: UserRecord, request: Request): string {
  return serializeSessionCookie(issueSessionValue(user), requestUsesHttps(request));
}
