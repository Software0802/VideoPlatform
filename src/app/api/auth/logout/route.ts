import { log } from "@/lib/log";
import { withRequestContext } from "@/lib/request-context";
import { requestUsesHttps, serializeClearSessionCookie, sessionUser } from "@/lib/users/session";
import { revokeUserSessions } from "@/lib/users/service";

export const runtime = "nodejs";

/**
 * 登出（方案 §3.2「安全收口」）。
 *
 * 除了清掉浏览器里的那份 Cookie，还把账号的 `sessionEpoch` 加一，让**所有**已签发的
 * Cookie 立刻失效。只清本地 Cookie 挡不住已经被复制走的那一份，而「我登出了」这句话
 * 的意思恰恰是「那张凭据从此不许再用」。代价是同一账号在别的设备上也会掉线——对一个
 * 面向个人的账号来说，这是符合直觉的一侧。
 *
 * 仍然是幂等的、也仍然不需要有效会话：没有会话（或会话已失效）时什么都不撤销，
 * 照常清 Cookie 回 `{ ok: true }`。撤销失败（磁盘写不进去）也不该让用户走不掉，
 * 只记一条日志。
 */
async function handler(request: Request) {
  const user = await sessionUser(request).catch(() => null);
  if (user) {
    try {
      await revokeUserSessions(user.id);
    } catch (error) {
      log("warn", "登出时撤销会话失败，仅清除本地 Cookie", {
        ownerId: user.id,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", serializeClearSessionCookie(requestUsesHttps(request)));
  return res;
}

export const POST = withRequestContext(handler);
