import { jsonError } from "@/lib/http";
import { retryJob } from "@/lib/jobs/create";
import { readJob } from "@/lib/jobs/store";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rec = await readJob(id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    const job = await retryJob(rec);
    return Response.json(job, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
