import { jsonError } from "@/lib/http";
import { toPublic } from "@/lib/jobs/store";
import { cancelOwnedJob } from "@/lib/jobs/cancel";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    // R09 的「产物已 checkpoint 则取消不成立」与清理 / SSE 细节都在
    // `cancelOwnedJob` 里（D 包抽出，画布 run 的取消走同一条路径）。
    const next = await cancelOwnedJob(user.id, id);
    if (!next) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    return Response.json(toPublic(next));
  } catch (e) {
    return jsonError(e);
  }
}
