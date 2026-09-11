import { jsonError } from "@/lib/http";
import { reconcileJob } from "@/lib/jobs/recovery";
import { readJobForUser } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 向上游核验一条 `uncertain_submit` 任务（恢复中心，A 包）。
 *
 * `{outcome: "resumed"}`：上游认领了这个外部单号，任务接管成 `pending` 继续跑；
 * `{outcome: "not_found"}`：上游确认没有这单，标记降级为普通失败、一键重试解锁；
 * 查询本身失败 → 409 `reconcile_failed`，标记保留、可稍后重试。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    const { job, outcome } = await reconcileJob(id);
    return Response.json({ job, outcome });
  } catch (e) {
    return jsonError(e);
  }
}
