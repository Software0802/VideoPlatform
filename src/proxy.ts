import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isLocalAdminRequest } from "@/lib/admin-token";
import { REQUEST_ID_HEADER, newRequestId } from "@/lib/request-id";
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
 *
 * 它还做两件与会话无关、但同样属于「请求进门前」的事（方案 §3.2）：
 * 给每个 `/api/*` 请求打一个 `x-request-id`（写进上游请求，也写回响应），以及对
 * 一切会改变状态的请求做同源校验。
 */

/** Reachable without a session. Everything else — `/api/me` included — needs one. */
const PUBLIC_API_PATHS = new Set([
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/logout",
  // Monitoring hits this without a cookie; anonymous callers get `{ ok }` only.
  "/api/health",
]);

/**
 * 分享链接（方案 §1.4）：`/api/share/<token>` 与 `.../media`。
 *
 * 它是**故意**公开的——收到链接的人没有本站账号，链接本身就是凭据。授权因此不在这里，
 * 而在 `@/lib/share/token` 的 HMAC 验签 + 过期判定；这里只负责别把它挡在门外。
 * 前缀匹配而不是枚举：路径里带着令牌，写不进 `PUBLIC_API_PATHS` 那张表。
 */
const PUBLIC_API_PREFIXES = ["/api/share/"];

function isPublicApiPath(pathname: string): boolean {
  return (
    PUBLIC_API_PATHS.has(pathname) ||
    PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/** 只读，不改变任何状态，所以不需要同源校验（也没法要求 —— `<img>` / 监控都是裸 GET）。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * 这次请求「应该」来自哪个 host。
 *
 * 生产在 Caddy 后面，`request.headers.host` 是反代与应用之间那一跳（`127.0.0.1:3000`），
 * 浏览器发的 `Origin` 永远是对外域名，所以必须先认 `x-forwarded-host`。
 * 反代会覆盖这个头；直连开发时它不存在，回落 `host`。
 */
function expectedHost(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const host = forwarded || request.headers.get("host")?.trim();
  return host ? host.toLowerCase() : null;
}

/** `Origin` 的 host 部分；缺省时退回 `Referer`（老浏览器 / 少数客户端只发后者）。 */
function claimedHost(request: NextRequest): string | null | undefined {
  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    // `null` 是浏览器对不透明来源（sandbox iframe、data: 文档）的写法，绝不放行。
    if (origin === "null") return null;
    try {
      return new URL(origin).host.toLowerCase();
    } catch {
      return null;
    }
  }
  const referer = request.headers.get("referer")?.trim();
  if (referer) {
    try {
      return new URL(referer).host.toLowerCase();
    } catch {
      return null;
    }
  }
  // 两个头都没有。**不是**浏览器发起的跨站请求：现代浏览器对每一个非 GET/HEAD 请求
  // （fetch、XHR、表单提交都算）都会带 `Origin`。挡下它只会挡掉 curl、冒烟脚本与
  // 部署脚本这类本来就拿不到 Cookie 的调用方，换不到任何 CSRF 防护。
  return undefined;
}

/**
 * 同源校验（方案 §3.2「安全收口」）。
 *
 * 会话是 `SameSite=Lax` 的 Cookie，跨站 POST 本来就带不上它——但 Lax 的边界随浏览器
 * 版本变过不止一次，而这里的每一个写接口都会花钱。这是第二把锁，判据只有一条：
 * 声称的来源必须与请求到达的 host 一致。
 */
function originMismatch(request: NextRequest): boolean {
  const claimed = claimedHost(request);
  if (claimed === undefined) return false;
  const expected = expectedHost(request);
  if (!expected) return true;
  return claimed !== expected;
}

export function proxy(request: NextRequest) {
  const pathname = normalize(request.nextUrl.pathname);
  // 每次都新生成，不认客户端带上来的值：这个 id 会被原样打进结构化日志，
  // 沿用请求里的字符串等于把日志的一个字段交给调用方写。被拒的请求同样要有
  // 一个 id——「我这次点提交报 403」正是最需要对号的那一类反馈。
  const reqId = newRequestId();

  const refuse = (status: number, code: string, message: string) => {
    const response = NextResponse.json({ error: { code, message } }, { status });
    response.headers.set(REQUEST_ID_HEADER, reqId);
    return response;
  };

  if (!SAFE_METHODS.has(request.method) && originMismatch(request)) {
    return refuse(403, "bad_origin", "请求来源不合法");
  }

  if (!isPublicApiPath(pathname)) {
    // 本机管理令牌（R4.1，D-4=b）：`/api/admin/` 下、Bearer 匹配、无 XFF 且
    // host 为 loopback 的直连请求不查会话。令牌只放行进门，路由内
    // `requireAdminActor` 会用同一份判据复查（proxy 覆盖面不保证完备）。
    const bypass =
      pathname.startsWith("/api/admin/") && isLocalAdminRequest(request);
    if (!bypass) {
      const value = readSessionCookie(request);
      if (!value || !verifySessionValue(value)) {
        return refuse(401, "unauthorized", "请先登录");
      }
    }
  }

  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, reqId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, reqId);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
