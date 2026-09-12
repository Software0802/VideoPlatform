import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { listRunsForCanvas } from "@/lib/canvas/dag";
import { readCanvas } from "@/lib/canvas/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 该画布的 run 列表（D 包）：倒序，前端 overlay 最新一次的节点产物用。 */
async function list(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const doc = await readCanvas(user.id, id);
    if (!doc) {
      return Response.json({ error: { code: "not_found", message: "画布不存在" } }, { status: 404 });
    }
    return Response.json({ runs: await listRunsForCanvas(user.id, id) });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
