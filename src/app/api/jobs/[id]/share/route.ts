import { jsonError } from "@/lib/http";
import { readJobForUser } from "@/lib/jobs/store";
import { isShareable } from "@/lib/share/resolve";
import { issueShareToken } from "@/lib/share/token";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 签一条分享链接（方案 §1.4）。
 *
 * 每次调用都签一条新令牌，不去重、也不存表：令牌是无状态的自证凭据，服务端没有「已
 * 签发过哪些」的账本，因此也没有吊销——收回的唯一手段是到期（`SHARE_TTL_HOURS`，默认
 * 24 小时）或删除作品（`DELETE /api/jobs/:id` 之后任务读不出来，链接立刻失效）。
 *
 * 只有成功且未被留存清理的作品能分享：链接指向的是成片字节，产物已经删了的任务分享
 * 出去只会是一个 404，还不如在这里就说清楚。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) {
      return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    }
    // 无主的老任务（管理员可见）签不出令牌：令牌里必须有一个合法的 ownerId 才能在
    // 验签时比对。与其让 `issueShareToken` 抛 500，不如在这里说「不能分享」。
    if (!rec.ownerId || !isShareable(rec)) {
      return Response.json(
        { error: { code: "job_not_shareable", message: "仅已完成且未清理的作品可分享" } },
        { status: 409 },
      );
    }
    const { token, expiresAt } = issueShareToken(rec.id, rec.ownerId);
    return Response.json({ url: `/s/${token}`, expiresAt });
  } catch (e) {
    return jsonError(e);
  }
}
