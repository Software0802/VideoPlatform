import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { localeFromRequest } from "@/lib/i18n/server";
import { requireUser } from "@/lib/users/session";
import { toPublicSession } from "@/lib/agent/public";
import { assertAgentRate } from "@/lib/agent/rate-limit";
import { runTurn } from "@/lib/agent/run-turn";
import { agentTurnBodySchema } from "@/lib/agent/schema";
import { readSession } from "@/lib/agent/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 续一轮（方案 §1）。限流与开新会话共用同一个桶（`@/lib/agent/rate-limit`）：
 * 两者花的钱一模一样。
 *
 * 返回整个会话而不是只返回新那两条：一轮可能同时改了标题、技能、产品选择并创建了
 * 任务，让前端自己把增量拼回去只会拼错。
 */
async function send(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const session = await readSession(user.id, id);
    if (!session) {
      return Response.json({ error: { code: "not_found", message: "会话不存在" } }, { status: 404 });
    }
    assertAgentRate(user.id);
    const body = agentTurnBodySchema.parse(await request.json());
    const { session: next } = await runTurn(session, { ownerId: user.id, locale: localeFromRequest(request), ...body });
    return Response.json({ session: await toPublicSession(next) });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(send);
