// @ts-check
/**
 * Session login for the smoke scripts.
 *
 * Every `/api/*` route needs a session cookie (`src/proxy.ts`), so a script has to
 * log in the same way a browser does: `POST /api/auth/login`, keep the
 * `lumen_session` cookie, send it on every request. Credentials come from the
 * environment and are never printed.
 *
 *   LUMEN_SMOKE_EMAIL      账号邮箱（必填）
 *   LUMEN_SMOKE_PASSWORD   密码（必填）
 *   LUMEN_SMOKE_INVITE     可选：账号不存在时用这个一次性邀请码注册再登录
 */

const SESSION_COOKIE = "lumen_session";

function readCredentials() {
  const email = process.env.LUMEN_SMOKE_EMAIL?.trim();
  const password = process.env.LUMEN_SMOKE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "缺少 LUMEN_SMOKE_EMAIL / LUMEN_SMOKE_PASSWORD：smoke 需要一个真实账号登录（见 .env.example）",
    );
  }
  return { email, password, invite: process.env.LUMEN_SMOKE_INVITE?.trim() || undefined };
}

/** @param {Response} response */
async function readError(response) {
  const text = await response.text();
  try {
    return JSON.parse(text)?.error?.message ?? text ?? `HTTP ${response.status}`;
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

/**
 * All `Set-Cookie` headers, whether the runtime exposes them joined or as a list.
 * @param {Response} response
 */
function setCookies(response) {
  const list = response.headers.getSetCookie?.();
  if (list && list.length) return list;
  const joined = response.headers.get("set-cookie");
  return joined ? [joined] : [];
}

/** @param {Response} response */
function sessionCookieFrom(response) {
  for (const raw of setCookies(response)) {
    const pair = raw.split(";", 1)[0]?.trim();
    if (pair?.startsWith(`${SESSION_COOKIE}=`) && pair.length > SESSION_COOKIE.length + 1) {
      return pair;
    }
  }
  return null;
}

/** @param {string} baseUrl @param {string} email @param {string} password */
async function login(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { response, cookie: response.ok ? sessionCookieFrom(response) : null };
}

/**
 * Log in and return the `Cookie` header value to attach to every request.
 * Registers first when the account is unknown and an invite code was supplied.
 * @param {string} baseUrl
 */
export async function loginForSmoke(baseUrl) {
  const { email, password, invite } = readCredentials();

  let { response, cookie } = await login(baseUrl, email, password);
  if (response.status === 401 && invite) {
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, inviteCode: invite }),
    });
    if (!register.ok) throw new Error(`注册失败: ${await readError(register)}`);
    ({ response, cookie } = await login(baseUrl, email, password));
  }
  if (!response.ok) throw new Error(`登录失败: ${await readError(response)}`);
  if (!cookie) throw new Error("登录成功但响应里没有会话 Cookie");
  return cookie;
}
