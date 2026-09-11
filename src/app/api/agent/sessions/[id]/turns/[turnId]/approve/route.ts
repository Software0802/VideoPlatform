import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { toPublicSession } from "@/lib/agent/public";
import { approveTurn } from "@/lib/agent/run-turn";
import { AGENT_MESSAGE_ID_RE } from "@/lib/agent/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; turnId: string }> };

/**
 * 批准提案（B 包默认批准制）：到这一刻才真的创建生成任务、才真的扣任务钱。
 * 幂等——重复批准交回同一份结果，action 幂等键 `agent:<turnId>:<i>` 兜住重复建单。
 */
async function approve(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id, turnId } = await ctx.params;
    if (!AGENT_MESSAGE_ID_RE.test(turnId)) {
      return Response.json({ error: { code: "not_found", message: "轮次不存在" } }, { status: 404 });
    }
    const { session } = await approveTurn(user.id, id, turnId);
    return Response.json({ session: await toPublicSession(session) });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(approve);
