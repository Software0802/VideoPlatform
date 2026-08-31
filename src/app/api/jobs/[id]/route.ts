import { jsonError } from "@/lib/http";
import { readJob, toPublic } from "@/lib/jobs/store";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rec = await readJob(id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    return Response.json(toPublic(rec));
  } catch (e) {
    return jsonError(e);
  }
}
