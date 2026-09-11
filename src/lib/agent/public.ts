import type { JobPublic } from "@/lib/jobs/schema";
import { readJobForUser, toPublic } from "@/lib/jobs/store";
import type { AgentMessage, AgentSession, AgentTurn } from "@/lib/agent/schema";

/**
 * 会话的对外投影。
 *
 * `ownerId` 不下发（浏览器已经知道自己是谁），任务用**任务自己的**公开投影
 * （`toPublic`）而不是重新拍一个形状：资产栏要显示状态、缩略图、售价，那些字段的
 * 事实源在 `jobs/schema.ts`，抄一份只会漂移。
 *
 * 任务按 `readJobForUser` 逐个读并过一遍归属：会话里的 id 是我们自己写的，但记录可能
 * 已经被删除 / 被留存清理动过，读不到的直接不出现在资产栏里。
 */
export type AgentSessionPublic = {
  id: string;
  title: string;
  skillId?: string;
  tier?: AgentSession["tier"];
  imageProduct?: string;
  videoProduct?: string;
  messages: AgentMessage[];
  /** 各轮的执行账（B 包）：待批准 / 执行中的轮次靠它恢复，刷新后界面能接着等。 */
  turns: AgentTurn[];
  /** 会话预算闸门（B 包）；缺省 = 不限。 */
  budget?: AgentSession["budget"];
  jobs: JobPublic[];
  createdAt: string;
  updatedAt: string;
};

export async function toPublicSession(session: AgentSession): Promise<AgentSessionPublic> {
  const records = await Promise.all(
    session.jobIds.map((id) => readJobForUser(id, session.ownerId).catch(() => null)),
  );
  return {
    id: session.id,
    title: session.title,
    ...(session.skillId ? { skillId: session.skillId } : {}),
    ...(session.tier ? { tier: session.tier } : {}),
    ...(session.imageProduct ? { imageProduct: session.imageProduct } : {}),
    ...(session.videoProduct ? { videoProduct: session.videoProduct } : {}),
    messages: session.messages,
    turns: session.turns ?? [],
    ...(session.budget ? { budget: session.budget } : {}),
    jobs: records.filter((r) => r !== null).map((r) => toPublic(r)),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
