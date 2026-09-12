import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { cancelCanvasRun } from "@/lib/canvas/dag";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 取消一次运行（D 包）：持久化 `cancelRequestedAt`——泵不再提交新节点，
 * 在途子任务按既有 job cancel 语义收敛（R09 checkpoint 不变），全终态后
 * run 落 `canceled`。终态 run 幂等交回。
 */
async function cancel(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const run = await cancelCanvasRun(user.id, id);
    return Response.json({ run });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(cancel);
