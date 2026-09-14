import { z } from "zod";
import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { readPrefs, setAgentSkillOff } from "@/lib/prefs/store";
import { ProviderHttpError } from "@/lib/providers/types";
import { requireUser } from "@/lib/users/session";
import { agentAvailable, agentChatModels } from "@/lib/agent/llm";
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
const patchBodySchema = z
  .object({
    skillId: z.string().min(1).max(64),
    off: z.boolean(),
  })
  .strict();

function currentOff(stored: string[], skills: ReturnType<typeof publicSkills>): string[] {
  const current = new Set(skills.map((skill) => skill.id));
  return stored.filter((id) => current.has(id));
}

async function list(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    const skills = publicSkills();
    const prefs = await readPrefs(user.id);
    return Response.json({
      skills,
      off: currentOff(prefs.agent.skillsOff, skills),
      available: agentAvailable(),
      chat: agentChatModels(),
    });
  } catch (e) {
    return jsonError(e);
  }
}

async function patch(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    const body = patchBodySchema.parse(await request.json());
    const skills = publicSkills();
    if (!skills.some((skill) => skill.id === body.skillId)) {
      throw new ProviderHttpError(400, "invalid_argument", "技能不存在");
    }
    const prefs = await setAgentSkillOff(user.id, body.skillId, body.off);
    return Response.json({ off: currentOff(prefs.agent.skillsOff, skills) });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
export const PATCH = withRequestContext(patch);
