import { log, runWithLogContext } from "@/lib/log";
import { REQUEST_ID_HEADER, newRequestId, readRequestId } from "@/lib/request-id";

/**
 * 路由处理器的请求上下文外壳（方案 §3.2「可观测性」）。
 *
 * 做两件事：把 `reqId` 放进 AsyncLocalStorage，让这次请求里任何一层的 `log()` 自动
 * 带上它；把同一个 id 写回响应头，让用户报障时能直接念出来对号。
 *
 * id 优先取 `src/proxy.ts` 已经写进上游请求的那个（同一次请求在 proxy 与 handler 里
 * 必须是同一个 id，否则日志对不上），proxy 没跑到时（直接调 handler 的单测、将来
 * 改了 matcher）就地生成一个。
 */
export function withRequestContext<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
): (request: Request, ...args: A) => Promise<Response> {
  return async (request: Request, ...args: A): Promise<Response> => {
    const reqId = readRequestId(request.headers) ?? newRequestId();
    return runWithLogContext({ reqId }, async () => {
      const response = await handler(request, ...args);
      // proxy 也会写一份；这里补的是「proxy 没跑到」的情况，且不覆盖 handler 自己
      // 已经写好的值。写头失败（不可变的 Response）不该把一次成功的请求变成 500。
      try {
        if (!response.headers.has(REQUEST_ID_HEADER)) {
          response.headers.set(REQUEST_ID_HEADER, reqId);
        }
      } catch {
        log("warn", "响应头不可写，x-request-id 未回写", { reqId });
      }
      return response;
    });
  };
}
