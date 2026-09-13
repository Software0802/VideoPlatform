import { z } from "zod";
import { notifyAlert } from "@/lib/alerts";
import { alertWebhookFormat } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { actorLabel, requireAdminActor } from "@/lib/users/admin-auth";

export const runtime = "nodejs";

/**
 * `POST /api/admin/alerts/test`（R7）：告警渠道的上线验证入口。
 * `sent` 直接回显 `notifyAlert` 的返回值——未配 webhook / 去重 / 非 2xx / 网络
 * 异常都会是 `false`（仍然是 200 响应：渠道失败不是这条接口的失败）。
 */
const bodySchema = z
  .object({
    note: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

async function post(request: Request) {
  try {
    const actor = await requireAdminActor(request);
    const body = bodySchema.parse(await request.json());
    const sent = await notifyAlert(
      "test",
      { note: body.note, actor: actorLabel(actor) },
      `test:${Date.now()}`,
    );
    return Response.json({ sent, format: alertWebhookFormat() });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(post);
