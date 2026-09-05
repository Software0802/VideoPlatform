import { jsonError } from "@/lib/http";
import { readJobForUser, toPublic } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    return Response.json(toPublic(rec));
  } catch (e) {
    return jsonError(e);
  }
}
