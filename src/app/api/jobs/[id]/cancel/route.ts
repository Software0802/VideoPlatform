import { jsonError } from "@/lib/http";
import { emitJob } from "@/lib/jobs/events";
import { readJobForUser, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";
import { deleteXaiFile } from "@/lib/providers/grok/client";
import { canCancel } from "@/lib/jobs/state-machine";
import { ProviderHttpError } from "@/lib/providers/types";
import { cleanupJobArtifacts } from "@/lib/jobs/local-output";
import { mediaStore } from "@/lib/storage/local-fs";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    if (!canCancel(rec.status)) {
      return Response.json({ error: { code: "conflict", message: "当前状态无法取消" } }, { status: 409 });
    }
    const next = await updateJob(id, (r) => {
      if (!canCancel(r.status)) {
        throw new ProviderHttpError(409, "conflict", "当前状态无法取消");
      }
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "已取消" };
      return r;
    });
    if (next.assets.source?.xaiFileId) void deleteXaiFile(next.assets.source.xaiFileId);
    await cleanupJobArtifacts(mediaStore.jobDir(next.id), tmpDir(), next.id, next.localOutputPath);
    emitJob(toPublic(next), { type: "status" });
    return Response.json(toPublic(next));
  } catch (e) {
    return jsonError(e);
  }
}
