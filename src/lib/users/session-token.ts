import { createHmac, timingSafeEqual } from "node:crypto";
import { USER_ID_RE, type UserRecord } from "@/lib/users/schema";

/**
 * The half of the session that is pure computation: signing, verifying, cookie
 * (de)serialization. Split out of `session.ts` on purpose — `src/proxy.ts`
 * imports only this file, so nothing that touches the filesystem is ever pulled
 * into the proxy bundle (plan §4: the proxy checks the signature, the route
 * handlers check `disabled` / `sessionEpoch` against `user.json`).
 */

export const SESSION_COOKIE = "lumen_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;
const MIN_SECRET_LENGTH = 16;

export const SESSION_SECRET_MISSING =
  "LUMEN_SESSION_SECRET 未设置或过短（至少 16 字符）。生成一个：PowerShell 里 " +
  "`-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })`，写进 .env.local / .env 后重启。";

/**
 * The signing key. Throws instead of falling back to anything derived or
 * random: a silent downgrade would either invalidate everyone's cookie on each
 * restart or, worse, sign with a guessable key (plan §3).
 */
export function sessionSecret(): string {
  const raw = process.env.LUMEN_SESSION_SECRET?.trim();
  if (!raw || raw.length < MIN_SECRET_LENGTH) throw new Error(SESSION_SECRET_MISSING);
  return raw;
}

/** Startup guard — see `src/instrumentation.ts`. */
export function assertSessionSecret(): void {
  sessionSecret();
}

export type SessionClaims = {
  userId: string;
  /** Unix seconds. */
  expiresAt: number;
  /** The user's `sessionEpoch` at issue time. */
  epoch: number;
};

function signature(claims: SessionClaims): string {
  return createHmac("sha256", sessionSecret())
    .update(`v1.${claims.userId}.${claims.expiresAt}.${claims.epoch}`)
    .digest("base64url");
}

export function signSession(claims: SessionClaims): string {
  if (!USER_ID_RE.test(claims.userId)) throw new Error("invalid user id");
  return `${claims.userId}.${claims.expiresAt}.${claims.epoch}.${signature(claims)}`;
}

export function issueSessionValue(user: UserRecord, nowMs: number = Date.now()): string {
  return signSession({
    userId: user.id,
    expiresAt: Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SEC,
    epoch: user.sessionEpoch,
  });
}

/**
 * Pure verification: format, signature, expiry. Deliberately does no file I/O,
 * so an unauthenticated caller cannot make the server touch the disk by
 * guessing user ids. `disabled` / epoch are checked afterwards by `sessionUser`.
 */
export function verifySessionValue(value: string, nowMs: number = Date.now()): SessionClaims | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [userId, expiresRaw, epochRaw, provided] = parts;
  if (!USER_ID_RE.test(userId)) return null;
  if (!/^[0-9]{1,15}$/.test(expiresRaw) || !/^[0-9]{1,15}$/.test(epochRaw)) return null;
  const claims: SessionClaims = {
    userId,
    expiresAt: Number(expiresRaw),
    epoch: Number(epochRaw),
  };
  let expected: string;
  try {
    expected = signature(claims);
  } catch {
    return null;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (claims.expiresAt * 1000 <= nowMs) return null;
  return claims;
}

export function readSessionCookie(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`).exec(cookie);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function requestUsesHttps(request: Request): boolean {
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function serializeSessionCookie(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secure ? "; Secure" : ""}`;
}

export function serializeClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
