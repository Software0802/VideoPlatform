/**
 * 请求相关 id 的最小公共定义（方案 §3.2「可观测性」）。
 *
 * 单独一个文件、只用 Web 标准 API：`src/proxy.ts` 会 import 它，而 proxy 是一段
 * 在应用外层跑的代码——把 `node:async_hooks`（`@/lib/log`）或任何触碰文件系统的东西
 * 拖进 proxy 的依赖图，只会换来一次难查的构建 / 运行期报错。
 */

/** 请求标识的传递头。proxy 写进上游请求，也写回响应，供用户报障时对号。 */
export const REQUEST_ID_HEADER = "x-request-id";

/** 8 位 hex。够一天的日志里区分请求，又短到能让人念出来。 */
export function newRequestId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * 请求上带的 id，**只认自己这一层写进去的形状**：8 位小写 hex。
 *
 * 客户端可以随便伪造这个头，而它会被原样打进结构化日志；不做格式校验就等于让
 * 任何人往日志里写任意字符串。认不出就当没有，由调用方新生成一个。
 */
export function readRequestId(headers: Headers): string | undefined {
  const raw = headers.get(REQUEST_ID_HEADER)?.trim();
  return raw && /^[0-9a-f]{8}$/.test(raw) ? raw : undefined;
}
