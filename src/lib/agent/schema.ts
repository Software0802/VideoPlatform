import { z } from "zod";
import { aspectRatioSchema, uploadIdSchema } from "@/lib/jobs/schema";

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
 * 资产引用（B 包）：LLM 动作里指向一份已上传素材的凭据。
 * 目前只有 `uploadId`（首帧图）——执行时经 `createJob` 的 sidecar 校验
 * 归属与角色，别人的 / 不存在的一律按无效处理，绝不静默丢。
 */
export const agentAssetRefSchema = z.object({ uploadId: uploadIdSchema }).strict();
export type AgentAssetRef = z.infer<typeof agentAssetRefSchema>;

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
  /** 首帧素材（仅 video 动作有意义，有了它动作变成图生视频）。 */
  imageRef: agentAssetRefSchema.optional(),
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
  /** 提案阶段带上的报价（批准后才创建任务、才真扣这笔钱）。 */
  priceCny: z.number().optional(),
});
export type AgentJobRef = z.infer<typeof agentJobRefSchema>;

/** 助手消息上的审批状态：提案挂出时是 `pending`，批准 / 拒绝后盖终态戳。 */
export const agentApprovalSchema = z.enum(["pending", "approved", "rejected"]);
export type AgentApproval = z.infer<typeof agentApprovalSchema>;

export const agentMessageSchema = z.object({
  id: z.string().regex(AGENT_MESSAGE_ID_RE),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  skillId: z.string().optional(),
  jobs: z.array(agentJobRefSchema).optional(),
  /** 这一轮的对话售价（人民币元），只挂在助手消息上。 */
  priceCny: z.number().optional(),
  /**
   * 提案审批状态（B 包默认批准制）：带 actions 的助手消息以 `pending` 落盘，
   * 任务在批准那一刻才创建；approve/reject 路由把它改写成终态。
   */
  approval: agentApprovalSchema.optional(),
  at: z.string(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/* ── Turn：一轮对话的执行账（B 包）───────────────────────────────────────── */

export const AGENT_TURN_STATUSES = [
  /** 已扣轮次费、LLM 正在跑（或上一次跑崩了，等重放补走）。 */
  "thinking",
  /** LLM 给了提案，等用户批准才创建任务。 */
  "awaiting_approval",
  /** 已批准，任务创建中。 */
  "executing",
  /** 无动作的纯答复，或提案已全部执行完。 */
  "succeeded",
  /** LLM 整轮失败，费用已退回。 */
  "failed",
  /** 用户拒绝了提案。 */
  "rejected",
] as const;
export const agentTurnStatusSchema = z.enum(AGENT_TURN_STATUSES);
export type AgentTurnStatus = z.infer<typeof agentTurnStatusSchema>;

/** 提案里每个动作的报价快照——批准时按这个价建任务，不重新算价。 */
export const agentQuotedActionSchema = agentActionSchema.extend({ priceCny: z.number() });
export type AgentQuotedAction = z.infer<typeof agentQuotedActionSchema>;

export const agentProposalSchema = z.object({
  actions: z.array(agentQuotedActionSchema),
  totalCny: z.number(),
  /** 报价有效期：过期后批准接口拒绝执行，用户重新发一轮拿新价。 */
  expiresAt: z.string(),
});
export type AgentProposal = z.infer<typeof agentProposalSchema>;

/**
 * 一轮对话的持久化执行账。事实源字段在会话文件里与消息一起原子落盘：
 * `requestHash` 守「同 key 异参 409」，`status` 让刷新后能接着等 / 接着批，
 * `chargeRef` / `refundRef` 是这条轮次在流水里的账目引用。
 */
export const agentTurnSchema = z.object({
  id: z.string().regex(AGENT_MESSAGE_ID_RE),
  /** sha256(规范化请求体)：重放同参交回现状，异参 409 `idempotency_conflict`。 */
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: agentTurnStatusSchema,
  /** 本轮对话费。 */
  priceCny: z.number(),
  chargeRef: z.string(),
  /** 失败退款行的 ref；存在即「这轮的账已经退过了」。 */
  refundRef: z.string().optional(),
  proposal: agentProposalSchema.optional(),
  /** 已批准创建的任务 id，按动作顺序。 */
  jobIds: z.array(z.string()).default([]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentTurn = z.infer<typeof agentTurnSchema>;

/** 会话级预算闸门：上限 + 已花额。`limitCny` 由用户设置（PATCH 会话），缺省不限。 */
export const agentBudgetSchema = z.object({
  limitCny: z.number().positive(),
  spentCny: z.number().nonnegative(),
});
export type AgentBudget = z.infer<typeof agentBudgetSchema>;

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
  /** 各轮的执行账（B 包）；老会话没有这个字段，读作空表。 */
  turns: z.array(agentTurnSchema).optional(),
  /** 会话预算闸门（B 包）；缺省 = 不限。 */
  budget: agentBudgetSchema.optional(),
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
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    /** 会话预算上限（元）：设正数开启闸门，`null` 解除。 */
    budgetCny: z.number().positive().max(100000).nullable().optional(),
  })
  .strict();

/** 标题取第一条用户输入的前 24 字（按码点，emoji 不会被切半个）。 */
export function titleFromText(text: string): string {
  const chars = [...text.trim().replace(/\s+/g, " ")];
  if (!chars.length) return "新会话";
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : chars.join("");
}
