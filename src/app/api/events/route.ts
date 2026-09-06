import { jsonError } from "@/lib/http";
import { onAnyJob, type JobEvent } from "@/lib/jobs/events";
import { readJobForUser } from "@/lib/jobs/store";
import { readSessionCookie, requireUser, sessionUserFromValue } from "@/lib/users/session";

export const runtime = "nodejs";
export const maxDuration = 900;

/**
 * 本人全站任务流（方案 §1.4「任务完成通知」）。
 *
 * 与 `/api/jobs/:id/events` 的分工：那条是「盯着我刚提交的这一条」，会在任务落终态后
 * 自己关闭；这条是「我这个账号有任何任务变了都告诉我」，一直开着，用户在别的页面
 * （主页瀑布流、订阅页）也能收到「片子出好了」。
 *
 * 过滤放在这里而不是发事件的地方：`JobPublic` 里没有 `ownerId`（浏览器不该知道别人的
 * 用户 id），`emitJob` 的调用点因此说不出这条任务是谁的。代价是每条事件要判一次归属，
 * 所以判过的结果按 jobId 记在连接内——一条连接对一条任务最多读一次 `job.json`。
 * 缓存负结果是安全的：`job.json` 是原子替换写的，读到的要么是旧版要么是新版，不会是
 * 「暂时不存在」，而 `ownerId` 一经创建就不再变。
 */
/**
 * 会话复核的间隔。这条流开着最长 `maxDuration` = 15 分钟，而鉴权只在建连那一刻做过一次：
 * 中途登出、改密（`sessionEpoch` +1）或被停用（`disabled`）之后，一条已经建好的连接会
 * 继续把任务事件推给一张理应作废的 Cookie。60 秒是「撤销后最多还能收多久」与「每分钟一次
 * `user.json` 读盘」之间的取舍——普通请求每次都复核，长连接按秒计一次。
 */
const SESSION_RECHECK_MS = 60_000;

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = (await requireUser(request)).id;
  } catch (e) {
    return jsonError(e);
  }
  // 建连时的那份 Cookie 值：复核要拿它重跑一次签名 + 过期 + epoch + disabled 的全套判定
  // （`sessionUserFromValue`），而不是只看进程内缓存的 userId。
  const sessionValue = readSessionCookie(request);

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let off: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearInterval(recheck);
        off();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };

      const visibility = new Map<string, boolean>();
      const mine = async (jobId: string): Promise<boolean> => {
        const cached = visibility.get(jobId);
        if (cached !== undefined) return cached;
        const allowed = Boolean(await readJobForUser(jobId, userId));
        // 长连接 + 大量任务时别让这张表无限长；清空只是让它重新读一次盘。
        if (visibility.size >= 1000) visibility.clear();
        visibility.set(jobId, allowed);
        return allowed;
      };

      // 串成一条链：判归属可能要读盘，不排队的话同一条任务的两次状态会乱序到达。
      let queue: Promise<void> = Promise.resolve();
      const deliver = (ev: JobEvent) => {
        queue = queue
          .then(async () => {
            if (closed || !(await mine(ev.job.id))) return;
            send(`event: job\ndata: ${JSON.stringify({ type: "job", job: ev.job })}\n\n`);
          })
          .catch(() => undefined);
      };

      off = onAnyJob(deliver);
      const ping = setInterval(() => send(": ping\n\n"), 15_000);
      // 会话没了就关流。读盘抛错也关：拿不准这张 Cookie 还算不算数时，宁可让浏览器的
      // EventSource 重连一次（它会重新走完整的鉴权），也不继续推。
      const recheck = setInterval(() => {
        void sessionUserFromValue(sessionValue).then(
          (user) => {
            if (!user || user.id !== userId) close();
          },
          () => close(),
        );
      }, SESSION_RECHECK_MS);
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener("abort", close);
      // 先冲一个注释帧：响应头要立刻发出去，浏览器的 EventSource 才算连上。
      send(": open\n\n");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
