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
    // R09：产物字节已经 checkpoint 的任务取消不再成立。`persisting` 意味着上游
    // 已经产出（费用已发生），`localOutputPath` 意味着字节已经拉到本地——这时把任务
    // 标成 canceled 只会让 persist 把一份已付费的产物删掉：上游收了钱、用户没拿到
    // 东西、平台也没收到钱，三方全输。此刻取消的契约是「任务按已产出来结算」：返回
    // 当前记录（仍是进行中），终态由 persist 的落盘路径写成 succeeded / failed。
    const next = await updateJob(id, (r) => {
      if (!canCancel(r.status)) {
        throw new ProviderHttpError(409, "conflict", "当前状态无法取消");
      }
      if (r.status === "persisting" || r.localOutputPath) return r;
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "已取消" };
      return r;
    });
    if (next.status !== "canceled") {
      // 读出来还是 persisting（上面那段没让它取消）：产物正在落盘，照常回 200，
      // SSE 会把终态推过去。这里不做产物清理——那会删掉正在入库的成片。
      return Response.json(toPublic(next));
    }
    if (next.assets.source?.xaiFileId) void deleteXaiFile(next.assets.source.xaiFileId);
    await cleanupJobArtifacts(mediaStore.jobDir(next.id), tmpDir(), next.id, next.localOutputPath);
    emitJob(toPublic(next), { type: "status" });
    return Response.json(toPublic(next));
  } catch (e) {
    return jsonError(e);
  }
}
