import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { agentAvailable } from "@/lib/agent/llm";
import { publicSkills } from "@/lib/agent/skills";

export const runtime = "nodejs";

/**
 * 技能目录（方案 §1）。名字与描述两种语言都下发，前端按当前界面语言取——它们是
 * **数据**，不是界面文案，所以不走 `messages/<locale>/agent.ts`。`systemPrompt` 不下发。
 *
 * 要会话：技能表是产品信息，没有必要对匿名访客开放，也不该成为另一条免登录的路径。
 *
 * `available` 说的是「这台实例配了对话提供方吗」（`AGENT_API_KEY` 或 `XAI_API_KEY`）。
 * 前端据此把输入卡置灰，而不是让用户敲完一句话再吃一个 503——技能表是页面上最早
 * 拉回来的一份数据，正好顺路把这个开关带上，不必再多一条路由。
 */
async function list(request: Request): Promise<Response> {
  try {
    await requireUser(request);
    return Response.json({ skills: publicSkills(), available: agentAvailable() });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
