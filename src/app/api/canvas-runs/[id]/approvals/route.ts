import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { canvasRunApprovalBodySchema } from "@/lib/canvas/schema";
import { decideCanvasRunApproval } from "@/lib/canvas/dag";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 审批门（D 切片二）：`{nodeId, decision: "approve"|"reject"}`。
 * 节点在 `awaiting_approval` 时决策才生效；同决策重放幂等交回，异决策/时机已过 409。
 */
async function decide(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const body = canvasRunApprovalBodySchema.parse(await request.json());
    const run = await decideCanvasRunApproval(user.id, id, body);
    return Response.json({ run });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(decide);
