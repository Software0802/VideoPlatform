import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { toPublicSession } from "@/lib/agent/public";
import { rejectTurn } from "@/lib/agent/run-turn";
import { AGENT_MESSAGE_ID_RE } from "@/lib/agent/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; turnId: string }> };

/** 拒绝提案：持久化终态，不创建任务；轮次费不退（对话本身已交付）。 */
async function reject(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id, turnId } = await ctx.params;
    if (!AGENT_MESSAGE_ID_RE.test(turnId)) {
      return Response.json({ error: { code: "not_found", message: "轮次不存在" } }, { status: 404 });
    }
    const { session } = await rejectTurn(user.id, id, turnId);
    return Response.json({ session: await toPublicSession(session) });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(reject);
