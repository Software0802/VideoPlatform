import { requestUsesHttps, serializeClearSessionCookie } from "@/lib/users/session";

export const runtime = "nodejs";

/** Idempotent: clearing a cookie needs no valid session. */
export async function POST(request: Request) {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", serializeClearSessionCookie(requestUsesHttps(request)));
  return res;
}
