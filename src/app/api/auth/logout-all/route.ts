import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requestUsesHttps, requireUser, serializeClearSessionCookie } from "@/lib/users/session";
import { revokeUserSessions } from "@/lib/users/service";

export const runtime = "nodejs";

/**
 * `POST /api/auth/logout-all`（H3 账户页「退出全部设备」）。
 *
 * 与 `POST /api/auth/logout` 的区别在**失败的朝向**：登出对没有会话的人也成功
 * （顺手清 Cookie），撤销失败只记日志照放人走；而「退出全部设备」是用户按下的
 * 安全动作，语义就是「这个账号的每张 Cookie 从此作废」——所以这里要求有效会话
 * （`requireUser`），`revokeUserSessions` 失败（磁盘写不进去、`sessionEpoch`
 * 没 bump）直接抛错：宁可报错让用户重试，也不能清掉本机 Cookie 回个 `{ok:true}`
 * 让他以为别处的会话已经死了。
 *
 * 成功后本机这台同样失效（Cookie 随响应清掉），客户端整页跳 `/login`——与改密
 * 不同，这里不留新会话。
 */
async function handler(request: Request) {
  try {
    const user = await requireUser(request);
    await revokeUserSessions(user.id);
    const res = Response.json({ ok: true });
    res.headers.append("Set-Cookie", serializeClearSessionCookie(requestUsesHttps(request)));
    return res;
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(handler);
