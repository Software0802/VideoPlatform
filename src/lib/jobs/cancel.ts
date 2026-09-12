import { emitJob } from "@/lib/jobs/events";
import { cleanupJobArtifacts } from "@/lib/jobs/local-output";
import { readJobForUser, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { canCancel } from "@/lib/jobs/state-machine";
import { deleteXaiFile } from "@/lib/providers/grok/client";
import { ProviderHttpError } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import type { JobRecord } from "@/lib/jobs/schema";

/**
 * 取消一条本人任务（D 包：从 `POST /api/jobs/:id/cancel` 提出来，画布 run 的
 * 取消要逐个对在途子任务走同一条路径，不复制第二份语义）。
 *
 * R09：产物字节已经 checkpoint 的任务取消不成立。`persisting` 意味着上游已经
 * 产出（费用已发生），`localOutputPath` 意味着字节已经拉到本地——这时把任务标成
 * canceled 只会让 persist 把一份已付费的产物删掉：上游收了钱、用户没拿到东西、
 * 平台也没收到钱，三方全输。此刻取消的契约是「任务按已产出来结算」：返回当前
 * 记录（仍是进行中），终态由 persist 的落盘路径写成 succeeded / failed。
 *
 * 返回 null = 任务不存在或不归该用户；409 `conflict` = 当前状态不能取消。
 */
export async function cancelOwnedJob(ownerId: string, jobId: string): Promise<JobRecord | null> {
  const rec = await readJobForUser(jobId, ownerId);
  if (!rec) return null;
  if (!canCancel(rec.status)) {
    throw new ProviderHttpError(409, "conflict", "当前状态无法取消");
  }
  const next = await updateJob(jobId, (r) => {
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
    // 读出来还是 persisting（上面那段没让它取消）：产物正在落盘，SSE 会把终态
    // 推过去。这里不做产物清理——那会删掉正在入库的成片。
    return next;
  }
  if (next.assets.source?.xaiFileId) void deleteXaiFile(next.assets.source.xaiFileId);
  await cleanupJobArtifacts(mediaStore.jobDir(next.id), tmpDir(), next.id, next.localOutputPath);
  emitJob(toPublic(next), { type: "status" });
  return next;
}
