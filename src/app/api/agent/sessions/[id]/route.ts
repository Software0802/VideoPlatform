import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { toPublicSession } from "@/lib/agent/public";
import { settleStaleTurns } from "@/lib/agent/run-turn";
import { agentPatchBodySchema } from "@/lib/agent/schema";
import { deleteSession, patchSession, readSession } from "@/lib/agent/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 非本人的会话与不存在的会话回**同一个** 404：拒绝的理由不该泄露这条 id 真实存在
 * （`docs/plan-users-quota.md` §5.1，与任务那边同一条纪律）。
 */
function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "会话不存在" } }, { status: 404 });
}

async function detail(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const session = await readSession(user.id, id);
    if (!session) return notFound();
    // 惰性结算：上次请求死在 LLM 半途的轮次在这里退款 + 标 failed（B 包）。
    const settled = await settleStaleTurns(user.id, session);
    return Response.json({ session: await toPublicSession(settled) });
  } catch (e) {
    return jsonError(e);
  }
}

/** 改标题与预算上限（B 包）。会话头是用户自己的归类，任何时候都能改。 */
async function rename(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const body = agentPatchBodySchema.parse(await request.json());
    const next = await patchSession(user.id, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.budgetCny !== undefined ? { budgetCny: body.budgetCny } : {}),
    });
    if (!next) return notFound();
    return Response.json({ session: await toPublicSession(next) });
  } catch (e) {
    return jsonError(e);
  }
}

/** 删对话记录，**不删任务**：作品在主页的作品流里，是已经付过钱的独立东西。 */
async function remove(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const ok = await deleteSession(user.id, id);
    if (!ok) return notFound();
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(detail);
export const PATCH = withRequestContext(rename);
export const DELETE = withRequestContext(remove);
