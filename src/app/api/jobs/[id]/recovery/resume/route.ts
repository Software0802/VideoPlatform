import { jsonError } from "@/lib/http";
import { resumeJob } from "@/lib/jobs/recovery";
import { readJobForUser } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 重新驱动一条任务（恢复中心，A 包）：非终态任务重新入队；`expired` 且还带着
 * `remoteId` 的转回 `pending` 续上放弃的轮询。其余终态 409。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    const job = await resumeJob(id);
    return Response.json({ job });
  } catch (e) {
    return jsonError(e);
  }
}
