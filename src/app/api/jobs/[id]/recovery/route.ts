import { jsonError } from "@/lib/http";
import { recoveryFor } from "@/lib/jobs/recovery";
import { readJobForUser } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 恢复中心（A 包）：返回这条任务此刻允许的手工恢复动作。
 *
 * `{actions: ["reconcile"]}` —— `failed + uncertain_submit` 且供应商支持按外部单号
 * 查询，可 `POST .../recovery/reconcile` 自助核验；`["resume"]` —— 非终态或带
 * remoteId 的过期任务，可 `POST .../recovery/resume` 重新驱动。
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    return Response.json(recoveryFor(rec));
  } catch (e) {
    return jsonError(e);
  }
}
