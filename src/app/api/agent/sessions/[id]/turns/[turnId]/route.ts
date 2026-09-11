import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { readTurn } from "@/lib/agent/run-turn";
import { AGENT_MESSAGE_ID_RE } from "@/lib/agent/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; turnId: string }> };

/**
 * 读单轮（B 包刷新恢复）：刷新 / 断线后界面拿它接着等——`thinking` 与
 * `executing` 的中途态是持久化的，`readTurn` 顺带惰性结算死掉的 thinking 轮
 * （退款 + failed），不会让一笔账永远挂着。
 */
async function detail(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id, turnId } = await ctx.params;
    if (!AGENT_MESSAGE_ID_RE.test(turnId)) {
      return Response.json({ error: { code: "not_found", message: "轮次不存在" } }, { status: 404 });
    }
    const found = await readTurn(user.id, id, turnId);
    if (!found) {
      return Response.json({ error: { code: "not_found", message: "轮次不存在" } }, { status: 404 });
    }
    return Response.json({ turn: found.turn });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(detail);
