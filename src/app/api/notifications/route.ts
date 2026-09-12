import { jsonError } from "@/lib/http";
import { notificationPayload, readNotifications } from "@/lib/notifications/store";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * `GET /api/notifications`（H 包 §2.3）：本人通知全量（≤200 条，按 seq 倒序）+
 * `epoch` / `lastReadSeq` / `unread`（服务端算好的未读数）。
 *
 * 不分页：200 条的量级上一次读完，「跳过 / 误标已读」的缝比一个稍大的响应更贵。
 * 文件不存在时 `readNotifications` 会以新 epoch 重建空文件返回——首个 GET 即建档。
 */
async function handler(request: Request) {
  try {
    const user = await requireUser(request);
    const file = await readNotifications(user.id);
    if (!file) {
      throw new ProviderHttpError(404, "not_found", "内容不存在或已被删除");
    }
    return Response.json(notificationPayload(file));
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(handler);
