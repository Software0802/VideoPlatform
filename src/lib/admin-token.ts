import { timingSafeEqual } from "node:crypto";
import { adminToken } from "@/lib/env";

/**
 * 本机管理令牌（R4.1，D-4=b）：`/api/admin/*` 除会话之外的第二条凭据，
 * 给 `scripts/*.mjs` 管理 CLI 走 HTTP 用。
 *
 * 三个条件**缺一不可**，proxy 与 `requireAdminActor` 用同一份判据（proxy
 * 覆盖面可能被 matcher 改动丢掉，路由内必须自查）：
 *
 * 1. `Authorization: Bearer <t>` 与 `LUMEN_ADMIN_TOKEN` 常量时间相等；
 * 2. `x-forwarded-for` 缺失或**每一跳都是 loopback**——生产拓扑里 Caddy
 *    对不受信客户端必覆盖写入该头为真实对端 IP（runbook「环境事实」的
 *    XFF 结论），所以外部请求带的一定不是 loopback；本机直连没有该头。
 *    `next dev` 的内部代理会给所有请求注入 `x-forwarded-for: ::ffff:…`，
 *    只认「没有 XFF」会让这条通道在开发环境整体失效——故接受全 loopback
 *    的转发链；含任何一个非 loopback 跳（公网 IP、docker 网关 10.255.x）
 *    的请求都不是本机直连；
 * 3. `host` 是 loopback（`127.0.0.1[:port]` / `localhost[:port]`）。
 *
 * 未配置令牌时这个通道整体关闭。
 */

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;
/** `127.0.0.0/8`、`::1`、IPv4-mapped `::ffff:127.x`（`next dev` 注入的形态）。 */
const LOOPBACK_XFF_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\]|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** 转发链是否「没有经过任何非本机的一跳」。 */
function xffIsLoopbackOrAbsent(request: Request): boolean {
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return true;
  const hops = xff.split(",").map((h) => h.trim());
  return hops.length > 0 && hops.every((h) => LOOPBACK_XFF_RE.test(h));
}

export function isLocalAdminRequest(request: Request): boolean {
  const token = adminToken();
  if (!token) return false;
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  if (!xffIsLoopbackOrAbsent(request)) return false;
  const host = request.headers.get("host");
  if (!host || !LOOPBACK_HOST_RE.test(host)) return false;
  return tokenEquals(auth.slice("Bearer ".length), token);
}

/** 长度不同的令牌直接不等；等长才进常量时间比较（timingSafeEqual 要求等长）。 */
function tokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
