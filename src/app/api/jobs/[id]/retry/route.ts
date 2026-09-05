import { jsonError } from "@/lib/http";
import { retryJob } from "@/lib/jobs/create";
import { readJobForUser } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    const job = await retryJob(rec, user.id);
    return Response.json(job, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
