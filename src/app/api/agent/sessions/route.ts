import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { localeFromRequest } from "@/lib/i18n/server";
import { requireUser } from "@/lib/users/session";
import { toPublicSession } from "@/lib/agent/public";
import { requireAgentLlmConfig } from "@/lib/agent/llm";
import { assertAgentRate } from "@/lib/agent/rate-limit";
import { runTurn } from "@/lib/agent/run-turn";
import { agentTurnBodySchema, titleFromText } from "@/lib/agent/schema";
import { createSession, deleteSession, listSessions } from "@/lib/agent/store";

export const runtime = "nodejs";

async function list(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    return Response.json({ sessions: await listSessions(user.id) });
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * 开一个会话 = 建文件 + **立刻跑第一轮**。
 *
 * 不做成「先建空会话，再单独发第一条消息」：那会在用户第一句话失败（余额不足、限流）
 * 时留下一个空壳会话，抽屉里多一条永远打不开的记录。
 */
async function create(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    // 没有对话提供方时连壳都不要建：`runTurn` 也会拦（那是扣款前的硬保证），
    // 这里早一步只是免掉一次「建了又删」的落盘。
    requireAgentLlmConfig();
    assertAgentRate(user.id);
    const body = agentTurnBodySchema.parse(await request.json());
    const session = await createSession(user.id, {
      title: titleFromText(body.text),
      skillId: body.skillId,
      tier: body.tier,
      imageProduct: body.imageProduct,
      videoProduct: body.videoProduct,
    });
    let next;
    try {
      ({ session: next } = await runTurn(session, { ownerId: user.id, locale: localeFromRequest(request), ...body }));
    } catch (error) {
      // 第一轮没跑成（余额不足、上游挂了）就把空壳收回去，别在抽屉里留一条打不开的记录。
      await deleteSession(user.id, session.id).catch(() => undefined);
      throw error;
    }
    return Response.json({ session: await toPublicSession(next) }, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
export const POST = withRequestContext(create);
