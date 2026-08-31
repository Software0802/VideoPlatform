import { jsonError } from "@/lib/http";
import {
  lumenAccessToken,
  serializeAccessCookie,
  serializeClearAccessCookie,
  tokensEqual,
} from "@/lib/auth";

export const runtime = "nodejs";

function requestUsesHttps(request: Request): boolean {
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

export async function POST(request: Request) {
  try {
    const expected = lumenAccessToken();
    if (!expected) {
      return Response.json({ ok: true, auth: "off" });
    }
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    if (!token || !tokensEqual(token, expected)) {
      return Response.json(
        { error: { code: "unauthorized", message: "令牌不正确" } },
        { status: 401 },
      );
    }
    const res = Response.json({ ok: true });
    res.headers.append(
      "Set-Cookie",
      serializeAccessCookie(token, undefined, requestUsesHttps(request)),
    );
    return res;
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(request: Request) {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", serializeClearAccessCookie(requestUsesHttps(request)));
  return res;
}
