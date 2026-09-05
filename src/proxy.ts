import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readSessionCookie, verifySessionValue } from "@/lib/users/session-token";

/**
 * Session gate for `/api/*` (plan §4).
 *
 * The proxy runs in front of the app and must stay cheap and I/O-free, so it
 * only does the pure half of the check: is there a cookie, and is its HMAC
 * signature valid and unexpired. Whether the account is still enabled and
 * whether the password has been changed since (`disabled` / `sessionEpoch`)
 * requires reading `user.json`, and that happens in each route handler through
 * `requireUser`. Neither layer is redundant: this one keeps unauthenticated
 * traffic away from the handlers, that one is the actual authorization.
 */

/** Reachable without a session. Everything else — `/api/me` included — needs one. */
const PUBLIC_API_PATHS = new Set([
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/logout",
  // Monitoring hits this without a cookie; its payload is unchanged.
  "/api/health",
]);

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function proxy(request: NextRequest) {
  const pathname = normalize(request.nextUrl.pathname);
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next();

  const value = readSessionCookie(request);
  if (!value || !verifySessionValue(value)) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "请先登录" } },
      { status: 401 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
