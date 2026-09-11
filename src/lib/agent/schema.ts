import { z } from "zod";
import { aspectRatioSchema } from "@/lib/jobs/schema";

/**
 * 智能体会话的形状（方案 `docs/plan-agent-i18n-subscription-2026-09.md` §1）。
 *
 * 事实源是 `data/agent/<userId>/<sessionId>.json`，一个会话一个文件——和任务一样：
 * 一次写只碰一个人的一个文件，坏一个不影响别的。这里的 schema 同时守两条边界：
 * 落盘的读回（手改过的文件不该让整页 500）和 HTTP 请求体（`.strict()`，多一个字段就拒）。
 */

export const AGENT_SESSION_ID_RE = /^ses_[0-9a-f]{16}$/;
export const AGENT_MESSAGE_ID_RE = /^msg_[0-9a-f]{16}$/;

/** 一个人最多留多少个会话。超出时 `POST /api/agent/sessions` 409 `too_many_sessions`。 */
export const MAX_SESSIONS_PER_USER = 200;

/** 一轮最多创建几个生成任务。LLM 说了不算，这里是硬闸门。 */
export const MAX_ACTIONS_PER_TURN = 2;

export const AGENT_TIERS = ["fast", "balanced", "quality"] as const;
export const agentTierSchema = z.enum(AGENT_TIERS);
export type AgentTier = z.infer<typeof agentTierSchema>;

export const agentActionKindSchema = z.enum(["image", "video"]);
export type AgentActionKind = z.infer<typeof agentActionKindSchema>;

/**
 * LLM 的输出契约。**不用 `.strict()`**：模型多吐一个字段是常事，为此把整轮判失败
 * （用户的钱已经扣了）不划算；多余字段直接丢掉即可。少字段、类型不对仍然判失败并重试。
 */
export const agentActionSchema = z.object({
  type: agentActionKindSchema,
  prompt: z.string().trim().min(1).max(2000),
  aspectRatio: aspectRatioSchema.optional(),
  durationSec: z.number().finite().optional(),
  /** 产品 id（`GET /api/models`）。认不出 / 当前不可用时由 `run-turn` 丢弃，不整轮失败。 */
  product: z.string().max(64).optional(),
});
export type AgentAction = z.infer<typeof agentActionSchema>;

export const agentReplySchema = z.object({
  reply: z.string().trim().min(1).max(4000),
  actions: z.array(agentActionSchema).max(8).default([]),
});
export type AgentReply = z.infer<typeof agentReplySchema>;

/**
 * 消息里挂的任务。创建成功有 `jobId`，被拒（余额不足 / 400）只有 `error`——
 * 一个 action 失败不该让整轮失败，用户该看到「这条为什么没出来」。
 */
export const agentJobRefSchema = z.object({
  jobId: z.string().optional(),
  kind: agentActionKindSchema,
  prompt: z.string(),
  error: z.string().optional(),
});
export type AgentJobRef = z.infer<typeof agentJobRefSchema>;

export const agentMessageSchema = z.object({
  id: z.string().regex(AGENT_MESSAGE_ID_RE),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  skillId: z.string().optional(),
  jobs: z.array(agentJobRefSchema).optional(),
  /** 这一轮的对话售价（人民币元），只挂在助手消息上。 */
  priceCny: z.number().optional(),
  at: z.string(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(AGENT_SESSION_ID_RE),
  ownerId: z.string(),
  title: z.string(),
  skillId: z.string().optional(),
  tier: agentTierSchema.optional(),
  imageProduct: z.string().optional(),
  videoProduct: z.string().optional(),
  messages: z.array(agentMessageSchema),
  /** 本会话创建过的任务 id，按创建顺序。资产栏读它，不去扫全站任务。 */
  jobIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

/** 列表页只要这几个字段；把整段对话搬进列表信封只会让抽屉越用越慢。 */
export type AgentSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  skillId?: string;
};

/**
 * 一轮的请求体。`POST /api/agent/sessions`（开新会话）与
 * `POST /api/agent/sessions/:id/messages`（续一轮）共用同一个形状。
 */
export const agentTurnBodySchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    skillId: z.string().max(64).optional(),
    tier: agentTierSchema.optional(),
    imageProduct: z.string().max(64).optional(),
    videoProduct: z.string().max(64).optional(),
    /**
     * 一轮对话的稳定身份（R08）：客户端在「一次发送」时生成，HTTP 层重试原样重发。
     * 服务端用它做幂等键（扣款 `agent:<turnId>`、动作 `agent:<turnId>:<i>`），
     * 会话里已有该 turnId 的 assistant 消息时整轮原样交回——网络重试不会扣第二次钱、
     * 不会多出半轮对话。缺省时服务端自取一个（老客户端 / 测试直调）。
     */
    turnId: z.string().regex(AGENT_MESSAGE_ID_RE).optional(),
  })
  .strict();
export type AgentTurnBody = z.infer<typeof agentTurnBodySchema>;

export const agentPatchBodySchema = z
  .object({ title: z.string().trim().min(1).max(80) })
  .strict();

/** 标题取第一条用户输入的前 24 字（按码点，emoji 不会被切半个）。 */
export function titleFromText(text: string): string {
  const chars = [...text.trim().replace(/\s+/g, " ")];
  if (!chars.length) return "新会话";
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : chars.join("");
}
