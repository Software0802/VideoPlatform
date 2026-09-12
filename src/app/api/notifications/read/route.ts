import { z } from "zod";
import { jsonError } from "@/lib/http";
import { markRead, notificationPayload } from "@/lib/notifications/store";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * `POST /api/notifications/read { epoch, upToSeq }`（H 包 §2.3）。
 *
 * 客户端永远持有全量（GET 一次给 ≤200 条），所以「打开铃铛 = 全部已读」，
 * `upToSeq` 就是它手里最大的 `seq`。`epoch` 对不上当前存储代际时 `markRead`
 * 抛 409 `notifications_stale`——客户端收到后重拉 GET，不重试 POST。
 * 成功返回与 GET 相同的形状（含服务端算好的 `unread`）。
 */
const bodySchema = z
  .object({
    epoch: z.string().min(1).max(64),
    upToSeq: z.number().int().min(0),
  })
  .strict();

async function handler(request: Request) {
  try {
    const user = await requireUser(request);
    const body = bodySchema.parse(await request.json());
    const file = await markRead(user.id, body.epoch, body.upToSeq);
    return Response.json(notificationPayload(file));
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(handler);
