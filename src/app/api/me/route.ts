import { jsonError } from "@/lib/http";
import { loadQuotaUsage, publicQuota } from "@/lib/jobs/quota";
import { toPublicUser } from "@/lib/users/schema";
import { sessionUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * The caller's own account: `{ userId, email, plan, quota }`.
 *
 * `quota` is counted live from `job.json` (plan §6.3) — `remaining` already
 * accounts for jobs still running, so the UI can show "今日剩余 n/10" without
 * knowing about the reservation model. `resetsAt` is the next Asia/Shanghai
 * midnight, in ISO.
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
    const quota = publicQuota(await loadQuotaUsage(user.id));
    return Response.json({ ...toPublicUser(user), quota });
  } catch (e) {
    return jsonError(e);
  }
}
