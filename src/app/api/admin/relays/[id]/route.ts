import { jsonError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { deleteRelay, updateRelay } from "@/lib/providers/relay/manage";
import { withRequestContext } from "@/lib/request-context";

export const runtime = "nodejs";

/** `PATCH /api/admin/relays/:id`：改 enabled / priority / 模型等字段（id 不可改）。 */
async function patch(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await ctx.params;
    const relay = await updateRelay(id, await request.json());
    return Response.json({ relay });
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * `DELETE /api/admin/relays/:id`：下线一条 relay。已注销的 provider 对象进影子表，
 * 正在跑的任务与历史 job.json 仍能解析；新任务路由立刻看不到它。
 */
async function remove(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await ctx.params;
    await deleteRelay(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(e);
  }
}

export const PATCH = withRequestContext(patch);
export const DELETE = withRequestContext(remove);
