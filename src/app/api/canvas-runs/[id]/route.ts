import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { readCanvasRunForUser } from "@/lib/canvas/dag";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** run 详情（D 包）：轮询是真相——前端拿它推进节点徽标与产物 overlay。 */
async function detail(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const run = await readCanvasRunForUser(user.id, id);
    return Response.json({ run });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(detail);
