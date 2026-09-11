import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { runCanvasNode } from "@/lib/canvas/run";
import { CANVAS_NODE_ID_RE } from "@/lib/canvas/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; nodeId: string }> };

/**
 * 运行一条生成节点（C 包）：内部走 `createJob`——与 `POST /api/jobs` 同一套
 * 准入 / 计价 / 预留 / 幂等。已有未终态任务时交回同一条，重复点击不重建。
 */
async function run(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id, nodeId } = await ctx.params;
    if (!CANVAS_NODE_ID_RE.test(nodeId)) {
      return Response.json({ error: { code: "not_found", message: "节点不存在" } }, { status: 404 });
    }
    const { canvas, job } = await runCanvasNode(user.id, id, nodeId);
    return Response.json({ canvas, job });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(run);
