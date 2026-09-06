import { jsonError } from "@/lib/http";
import { deleteJobDirectory } from "@/lib/jobs/delete";
import { isTerminalStatus } from "@/lib/jobs/schema";
import { readJobForUser, toPublic, updateJob } from "@/lib/jobs/store";
import { updateJobTagsBodySchema } from "@/lib/jobs/tags";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return notFound();
    return Response.json(toPublic(rec));
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * 改标签（方案 §1.4）。任意状态都可以改——标签是用户对作品的归类，与任务跑到哪一步
 * 无关，排队中就想先归好类是合理的。
 *
 * 整组覆盖而不是增删单个：前端那排芯片本来就是「当前选中的全集」，PATCH 一次说清楚
 * 比 add/remove 两条路径少一半竞态。
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    // 先按可见性判一次：非本人的任务与不存在的任务同样是 404（plan-users-quota §5.1），
    // 不能让「改标签失败的理由」泄露出这条 id 真实存在。
    const rec = await readJobForUser(id, user.id);
    if (!rec) return notFound();
    const { tags } = updateJobTagsBodySchema.parse(await request.json());
    // 走 `updateJob` 而不是自己写盘：它持有这条任务的锁，runner 正在写状态时不会被覆盖。
    const next = await updateJob(id, (r) => {
      r.tags = tags;
      return r;
    });
    return Response.json(toPublic(next));
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * 删除一条作品（方案 §1.4）。
 *
 * 只允许终态：进行中的任务另一端正有 runner 拿着锁写盘，删了目录只会让它炸在写 job.json
 * 上，还留下半个目录——想删就先取消（`POST /api/jobs/:id/cancel`），所以这里回 409 而
 * 不是替用户取消。
 *
 * 这里的终态判断只是快速失败（省一次进队列）：真正说了算的是 `deleteJobById` 在任务锁内
 * 拿新鲜记录做的那一次复核，它抛同一个 409 `job_active`——读到这份快照与真正落刀之间，
 * 任务可能已经被 retry 推回非终态。
 *
 * 钱不退：已发生的上游调用不会因为删除而没发生（`deleteJobDirectory` 注释）。
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return notFound();
    if (!isTerminalStatus(rec.status)) {
      return Response.json(
        { error: { code: "job_active", message: "任务进行中，请先取消再删除" } },
        { status: 409 },
      );
    }
    await deleteJobDirectory(rec);
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(e);
  }
}
