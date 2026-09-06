import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { ProviderHttpError } from "@/lib/providers/types";
import { clientIp, consumeRateLimit } from "@/lib/users/rate-limit";
import { changePasswordBodySchema } from "@/lib/users/schema";
import { issueSessionCookie, requireUser } from "@/lib/users/session";
import { changeUserPasswordWithCurrent } from "@/lib/users/service";

export const runtime = "nodejs";

/** 每分钟 5 次。比登录（10 次）更紧：这里是拿会话去撞旧密码，本来就不该有高频。 */
const PASSWORD_RATE_LIMIT = 5;

/**
 * 自助改密（方案 §3.4「账号闭环」）。
 *
 * 成功后 `sessionEpoch` 加一，于是**所有**已签发的 Cookie 立刻失效；这里紧接着按新
 * 记录签一张回去，所以发起改密的这台设备不掉线，其它设备下一次请求就是 401。
 * 这正是「我怀疑密码泄漏了」时想要的效果，也是不另开一个「登出所有设备」按钮的理由。
 */
async function handler(request: Request) {
  try {
    const user = await requireUser(request);
    // 限流键与登录同构：IP 与账号各一个桶，换其中一个都拿不到新额度。
    const gate = consumeRateLimit(
      [`password:ip:${clientIp(request)}`, `password:user:${user.id}`],
      { limit: PASSWORD_RATE_LIMIT },
    );
    if (!gate.allowed) {
      throw new ProviderHttpError(
        429,
        "rate_limited",
        `改密请求过于频繁，请 ${gate.retryAfterSec} 秒后再试`,
      );
    }
    const body = changePasswordBodySchema.parse(await request.json());
    const next = await changeUserPasswordWithCurrent({
      userId: user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    const res = Response.json({ ok: true });
    res.headers.append("Set-Cookie", issueSessionCookie(next, request));
    return res;
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(handler);
