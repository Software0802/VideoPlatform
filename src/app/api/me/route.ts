import { loadBalanceUsage } from "@/lib/billing/admission";
import { priceTable } from "@/lib/billing/prices";
import { jsonError } from "@/lib/http";
import { loadQuotaUsage, publicQuota } from "@/lib/jobs/quota";
import { toPublicUser } from "@/lib/users/schema";
import { sessionUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * The caller's own account: `{ userId, email, plan, balance, prices, quota }`.
 *
 * `balance` 与 `prices` 是余额模型的两半（方案 §3.2）：前者现算（余额 − 在途预留），
 * 后者是价目表本身，交给提交面板在本地算「本次约 ¥x」——同一份表两边用，界面上的
 * 数字和服务端的判定才不会各说各话。
 *
 * `quota` is counted live from `job.json` (plan §6.3) — `remaining` already
 * accounts for jobs still running, so the UI can show "今日剩余 n/10" without
 * knowing about the reservation model. `resetsAt` is the next Asia/Shanghai
 * midnight, in ISO.
 *
 * `quota.blocked` carries the stop-loss valve (plan §6.1). It exists because
 * `remaining` alone lies in one case: 30 failures with nothing succeeded reads
 * as "还剩 10 次" while every submission is refused with `failure_limit_reached`.
 * It is produced by the same `quotaBlock` the admission check uses, so the two
 * cannot drift apart.
 */
export async function GET(request: Request) {
  try {
    const user = await sessionUser(request);
    if (!user) {
      return Response.json(
        { error: { code: "unauthorized", message: "请先登录" } },
        { status: 401 },
      );
    }
    const [quotaUsage, balance] = await Promise.all([loadQuotaUsage(user.id), loadBalanceUsage(user.id)]);
    return Response.json({
      ...toPublicUser(user),
      balance,
      prices: priceTable(),
      quota: publicQuota(quotaUsage),
    });
  } catch (e) {
    return jsonError(e);
  }
}
