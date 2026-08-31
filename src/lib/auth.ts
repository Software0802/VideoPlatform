export const ACCESS_COOKIE = "lumen_token";

export function lumenAccessToken(): string | undefined {
  const t = process.env.LUMEN_ACCESS_TOKEN?.trim();
  return t || undefined;
}

export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function presentedToken(request: Request): string | undefined {
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    const bearer = m?.[1]?.trim();
    if (bearer) return bearer;
  }
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  const m = new RegExp(`(?:^|;\\s*)${ACCESS_COOKIE}=([^;]*)`).exec(cookie);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function isAuthorized(request: Request): boolean {
  const expected = lumenAccessToken();
  if (!expected) return true;
  const got = presentedToken(request);
  return Boolean(got && tokensEqual(got, expected));
}

export function unauthorizedJson(): Response {
  return Response.json(
    { error: { code: "unauthorized", message: "需要访问令牌" } },
    { status: 401 },
  );
}

export function serializeAccessCookie(
  token: string,
  maxAgeSec = 60 * 60 * 24 * 30,
  secureOverride?: boolean,
): string {
  const secure = (secureOverride ?? process.env.NODE_ENV === "production") ? "; Secure" : "";
  return `${ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function serializeClearAccessCookie(secureOverride?: boolean): string {
  const secure = (secureOverride ?? process.env.NODE_ENV === "production") ? "; Secure" : "";
  return `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
