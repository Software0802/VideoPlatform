import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { readCanvas } from "@/lib/canvas/store";
import { CANVAS_MAX_NODES } from "@/lib/canvas/graph";
import { workflowFromCanvas } from "@/lib/workflows/from-canvas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 这张画布跑一次是哪些步骤、哪几步前面有人审门（`src/lib/workflows/types.ts`）。
 *
 * 只读投影，不建 run、不报价、不碰钱；`gates` 是报价弹层里当下勾选的节点 id，
 * 认不出的 id 直接忽略（投影只查「这一步在不在勾选集合里」）。非本人与不存在
 * 同 404，与画布详情同口径。
 */
async function workflow(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const doc = await readCanvas(user.id, id);
    if (!doc) {
      return Response.json({ error: { code: "not_found", message: "画布不存在" } }, { status: 404 });
    }
    const gates = (new URL(request.url).searchParams.get("gates") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, CANVAS_MAX_NODES);
    return Response.json({ workflow: workflowFromCanvas(doc, { gates }) });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(workflow);
