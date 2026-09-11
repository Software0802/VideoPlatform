import { createHash } from "node:crypto";
import { assertBalance } from "@/lib/billing/admission";
import { applyBalanceChange, hasEntryFor } from "@/lib/billing/ledger";
import { agentTurnPriceCny, priceCny } from "@/lib/billing/prices";
import { log } from "@/lib/log";
import { round2 } from "@/lib/billing/protocol.mjs";
import { withAdmissionLock } from "@/lib/jobs/admission";
import { createJob } from "@/lib/jobs/create";
import { consumeJobCreation } from "@/lib/jobs/rate-limit";
import type { CreateJobBody } from "@/lib/jobs/schema";
import { availableProducts, isProductAvailable, productById } from "@/lib/products/catalog";
import { ProviderHttpError } from "@/lib/providers/types";
import {
  completeAgentTurn,
  requireAgentLlmConfig,
  type AgentChatMessage,
  type AgentCompleter,
  type AgentLlmConfig,
} from "@/lib/agent/llm";
import {
  MAX_ACTIONS_PER_TURN,
  type AgentAction,
  type AgentJobRef,
  type AgentMessage,
  type AgentProposal,
  type AgentQuotedAction,
  type AgentSession,
  type AgentTier,
  type AgentTurn,
} from "@/lib/agent/schema";
import { agentSkillById } from "@/lib/agent/skills";
import { newMessageId, readSession, updateSession } from "@/lib/agent/store";
import type { Locale } from "@/lib/i18n/locales";

/**
 * 一轮对话（方案 §1 + B 包「默认批准制」）。
 *
 * 顺序是**先扣轮次费、再调用、再提案**：一次 LLM 调用一旦发出就已经花掉了，把扣款
 * 放在它后面等于开一个「崩了就白送一次」的窗口。幂等键 `agent:<turnId>` 由
 * `applyBalanceChange` 扫流水去重，所以重放不会重复扣。
 *
 * B 包之后，LLM 给出的 actions **不直接建任务**：先落成 `proposal`（含每条报价与
 * 有效期），turn 停在 `awaiting_approval`，助手消息带 `approval:"pending"`；
 * 用户批准（`approveTurn`）那一刻才按报价快照逐条 `createJob`——生成任务的扣款
 * 由此过了「用户确认」这道闸，不再是模型一句话说了算。
 *
 * 反过来，调用**整个失败**（三次都没拿到合法回复、上游挂了）时把这一轮退回去：
 * 「上游挂了不该用户掏钱」在任务那边是不扣款，在这里就得是退款，因为钱已经扣了。
 * 退款走同一个 `applyBalanceChange`（`kind:"adjust"`，`ref` 加 `:refund` 后缀），
 * 不另写一份扣款逻辑——AGENTS.md 的硬约束。
 *
 * 会话级预算（`session.budget`）：设了上限后，轮次费在扣款时计入、提案总额在批准
 * 前核对；花超就 402 `budget_exhausted`，不悄悄放行。
 */

const BASE_SYSTEM_PROMPT = `你是 Genius 的创作智能体。用户用一句话说出想法，你负责把它变成可以下单的生成提案。

规则：
1. 只输出 JSON，形状是 {"reply": string, "actions": Action[]}，不要 Markdown 代码块，不要任何解释文字。
2. reply 两到四句，说清你理解的画面方向和提案要生成什么。不要重复用户原话，不要列清单。
3. actions 最多 ${MAX_ACTIONS_PER_TURN} 条；用户只是在聊天、提问或信息不足时给空数组。actions 是**提案**：用户看过批准之后才会真正生成，所以 reply 里别说"已经开始生成"。
4. Action 形状：{"type":"image"|"video","prompt":string,"aspectRatio"?:string,"durationSec"?:number,"product"?:string}。
5. prompt 用中文写给生成模型看：一句可拍的场景 + 一个明确的镜头运动或构图 + 光线与色温 + 一句显式的"保持 X 不变"锁定项。锁定项写具体可检的事物（发型长度、服装颜色、光向、色板），不写抽象形容词。
6. aspectRatio 只能是 16:9、9:16、1:1、4:3、3:4、3:2、2:3 之一；durationSec 只能是 5 或 10。
7. product 只能填下面「可用产品」里的 id，拿不准就不填，由服务端按用户当前配置选。`;

/** 服务端认的时长档。LLM 给别的值就丢掉，让服务端按默认走——不让一句话把任务推进长片管线。 */
const ALLOWED_DURATIONS = new Set([5, 10]);

/** 提案报价的有效期：过期即「价格变了请重新发」，批准接口拒绝执行。 */
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/**
 * 「还在 thinking」超过这个时长 = 发起它的那次请求已经死了（进程重启 / 连接断），
 * 读会话时惰性结算：退款 + turn 标 failed——不让一笔永远停在「思考中」的账挂着。
 */
const STALE_THINKING_MS = 2 * 60 * 1000;

export type RunTurnOptions = {
  /** 测试接缝：不传就按「哪家有 key」选提供方（都没有则 mock）。 */
  complete?: AgentCompleter;
  config?: AgentLlmConfig;
};

export type RunTurnInput = {
  ownerId: string;
  text: string;
  skillId?: string;
  tier?: AgentTier;
  imageProduct?: string;
  videoProduct?: string;
  /** 一轮的稳定身份（R08）：HTTP 重试原样带回，扣款 / 提案 / 建任务全部按它幂等。 */
  turnId?: string;
  /** 回复语言（B 包）：跟随界面语言，缺省中文。 */
  locale?: Locale;
};

export type RunTurnResult = {
  session: AgentSession;
  turn: AgentTurn;
  assistant: AgentMessage | null;
};

/** 请求指纹：同 key 重放靠它区分「原样重发」与「换参复用」。 */
export function hashTurnRequest(input: Omit<RunTurnInput, "ownerId" | "turnId" | "locale">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: input.text,
        skillId: input.skillId ?? null,
        tier: input.tier ?? null,
        imageProduct: input.imageProduct ?? null,
        videoProduct: input.videoProduct ?? null,
      }),
    )
    .digest("hex");
}

function findAssistant(session: AgentSession, turnId: string): AgentMessage | null {
  return session.messages.find((m) => m.role === "assistant" && m.id === turnId) ?? null;
}

function conflict(): ProviderHttpError {
  return new ProviderHttpError(409, "idempotency_conflict", "同一轮次键被用于不同的输入，请重新发起");
}

/**
 * 发起 / 重放一轮。
 *
 * 重放语义（R08 + B 包）：同 `turnId` + 同请求指纹 → 交回轮次的**当前状态**
 * （thinking 中的会接着把没跑完的 LLM 补上）；同 key 异参 → 409。
 */
export async function runTurn(
  session: AgentSession,
  input: RunTurnInput,
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const ownerId = input.ownerId;
  const turnId = input.turnId ?? newMessageId();
  const ref = `agent:${turnId}`;
  const requestHash = hashTurnRequest(input);

  const fresh = await readSession(ownerId, session.id);
  if (!fresh) throw new ProviderHttpError(404, "not_found", "会话不存在");

  const prior = fresh.turns?.find((t) => t.id === turnId);
  if (prior) {
    if (prior.requestHash !== requestHash) throw conflict();
    if (prior.status !== "thinking") {
      // 终态 / 待批 / 执行中的轮次原样交回——不重扣、不再调 LLM。
      return { session: fresh, turn: prior, assistant: findAssistant(fresh, turnId) };
    }
    // thinking 卡住多半是上次请求死在中途：扣款行按 ref 幂等，接着往下把 LLM 补跑完。
  } else {
    // B 包之前的轮次没有 turns 表：按助手消息回放（同参交回 / 异参 409）。
    const idx = fresh.messages.findIndex((m) => m.role === "assistant" && m.id === turnId);
    if (idx >= 0) {
      const before = fresh.messages[idx - 1];
      if (!before || before.role !== "user" || before.text !== input.text) throw conflict();
      const legacy: AgentTurn = {
        id: turnId,
        requestHash,
        status: "succeeded",
        priceCny: fresh.messages[idx].priceCny ?? 0,
        chargeRef: ref,
        jobIds: [],
        createdAt: fresh.messages[idx].at,
        updatedAt: fresh.messages[idx].at,
      };
      return { session: fresh, turn: legacy, assistant: fresh.messages[idx] };
    }
    // 同 turnId 的一轮以前跑过、但 LLM 整轮失败退了款：扣款行与退款行都已落账，
    // 再走一遍的话扣款被幂等跳过、LLM 却真的又调了——等于白送一轮。这不是重放，
    // 是一次已被结算过的失败请求被原样重发；显式拒绝，客户端要重试就换 key。
    if (await hasEntryFor(ownerId, "adjust", `${ref}:refund`)) {
      throw new ProviderHttpError(409, "idempotency_conflict", "这一轮已经失败退款，请重新发起");
    }
  }

  // 一家可用的对话提供方都没有时到此为止，而且必须在扣款**之前**：先扣再退会在流水上
  // 留下一对无意义的进出，用户却什么都没拿到。注入了替身的调用（测试）不需要真凭据。
  if (!options.complete && !options.config) requireAgentLlmConfig();
  const tier = input.tier ?? fresh.tier ?? "balanced";
  const skillId = input.skillId ?? fresh.skillId;
  const skill = agentSkillById(skillId);
  const imageProduct = input.imageProduct ?? fresh.imageProduct;
  const videoProduct = input.videoProduct ?? fresh.videoProduct;
  const locale = input.locale ?? "zh-CN";

  const turnPrice = agentTurnPriceCny();
  const userMessage: AgentMessage = {
    id: newMessageId(),
    role: "user",
    text: input.text,
    ...(skill ? { skillId: skill.id } : {}),
    at: new Date().toISOString(),
  };
  const now = new Date().toISOString();
  const turn: AgentTurn = prior ?? {
    id: turnId,
    requestHash,
    status: "thinking",
    priceCny: turnPrice,
    chargeRef: ref,
    jobIds: [],
    createdAt: now,
    updatedAt: now,
  };

  // 判定与扣款必须在同一个 `withAdmissionLock` 临界区里（AGENTS.md 硬约束）：出了锁，
  // 并发的两轮会读到同一份「还够一次」的余额然后一起放行。会话预算的检查落在
  // `updateSession` 的锁内回调里（会话锁），超额时抛错由外层补退款。
  if (turnPrice > 0) {
    await withAdmissionLock(async () => {
      await assertBalance(ownerId, turnPrice);
      await applyBalanceChange(ownerId, -turnPrice, {
        kind: "charge",
        amountCny: -turnPrice,
        ref,
        note: "智能体对话",
      });
      try {
        const persisted = await updateSession(ownerId, session.id, (s) => {
          if (s.budget && round2(s.budget.spentCny + turnPrice) > s.budget.limitCny) {
            throw new ProviderHttpError(402, "budget_exhausted", "本会话预算已用完，可在会话设置里调高上限");
          }
          if (s.turns?.some((t) => t.id === turnId)) return s; // 重放：账已记过
          return {
            ...s,
            // 这轮点名的技能 / 档位 / 产品同步进会话头（旧 appendTurn 的 patch 语义）。
            ...(skill ? { skillId: skill.id } : {}),
            tier,
            ...(imageProduct ? { imageProduct } : {}),
            ...(videoProduct ? { videoProduct } : {}),
            messages: [...s.messages, userMessage],
            turns: [...(s.turns ?? []), turn],
            ...(s.budget ? { budget: { ...s.budget, spentCny: round2(s.budget.spentCny + turnPrice) } } : {}),
          };
        });
        if (!persisted) throw new ProviderHttpError(404, "not_found", "会话不存在");
      } catch (error) {
        // 预算 / 会话已删的拒绝发生在扣款之后——把刚扣的轮次费退回去再抛。
        if (error instanceof ProviderHttpError && error.code === "budget_exhausted") {
          await refundTurn(ownerId, turnPrice, ref);
        }
        throw error;
      }
    });
  }

  let reply: Awaited<ReturnType<typeof completeAgentTurn>>;
  try {
    reply = await completeAgentTurn({
      messages: buildMessages(fresh, input.text, skill?.systemPrompt, locale),
      tier,
      complete: options.complete,
      config: options.config,
    });
  } catch (error) {
    if (turnPrice > 0) await refundTurn(ownerId, turnPrice, ref);
    await updateSession(ownerId, session.id, (s) =>
      s.turns?.some((t) => t.id === turnId && t.status === "thinking")
        ? {
            ...s,
            turns: s.turns!.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    status: "failed" as const,
                    refundRef: `${ref}:refund`,
                    error: { code: "agent_unavailable", message: "智能体未能给出合法回复" },
                    updatedAt: new Date().toISOString(),
                  }
                : t,
            ),
            // 退款 = 这轮没花钱：预算已花额同步退回。
            ...(s.budget ? { budget: { ...s.budget, spentCny: Math.max(0, round2(s.budget.spentCny - turnPrice)) } } : {}),
          }
        : undefined,
    );
    throw error instanceof ProviderHttpError
      ? error
      : new ProviderHttpError(502, "agent_unavailable", "智能体暂时无法回复，本轮费用已退回");
  }

  // 技能能力过滤（B 包）：技能声明了 kinds 的，越界的动作直接丢掉——它是「这个技能
  // 只出图」的契约，不是建议。丢完一条不剩就退化成纯答复。
  const actions = reply.actions
    .slice(0, MAX_ACTIONS_PER_TURN)
    .filter((a) => !skill?.kinds || skill.kinds.includes(a.type));

  const assistant: AgentMessage = {
    id: turnId,
    role: "assistant",
    text: reply.reply,
    ...(skill ? { skillId: skill.id } : {}),
    priceCny: turnPrice,
    at: new Date().toISOString(),
  };

  if (!actions.length) {
    // 纯答复：没有可执行的东西，turn 直接成功。
    const next = await updateSession(ownerId, session.id, (s) => {
      if (!s.turns?.some((t) => t.id === turnId)) return undefined;
      return {
        ...s,
        messages: s.messages.some((m) => m.id === turnId) ? s.messages : [...s.messages, assistant],
        turns: s.turns.map((t) =>
          t.id === turnId ? { ...t, status: "succeeded" as const, updatedAt: new Date().toISOString() } : t,
        ),
      };
    });
    if (!next) throw new ProviderHttpError(404, "not_found", "会话不存在");
    return {
      session: next,
      turn: next.turns!.find((t) => t.id === turnId)!,
      assistant,
    };
  }

  // 默认批准制：报价快照落提案，turn 停 awaiting_approval，助手消息带 approval=pending。
  const quoted: AgentQuotedAction[] = actions.map((a) => ({ ...a, priceCny: quoteAction(a) }));
  const proposal: AgentProposal = {
    actions: quoted,
    totalCny: round2(quoted.reduce((sum, a) => sum + a.priceCny, 0)),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
  };
  const proposalMessage: AgentMessage = {
    ...assistant,
    approval: "pending",
    jobs: quoted.map((a) => ({ kind: a.type, prompt: a.prompt, priceCny: a.priceCny })),
  };
  const next = await updateSession(ownerId, session.id, (s) => {
    if (!s.turns?.some((t) => t.id === turnId)) return undefined;
    return {
      ...s,
      messages: s.messages.some((m) => m.id === turnId) ? s.messages : [...s.messages, proposalMessage],
      turns: s.turns.map((t) =>
        t.id === turnId
          ? { ...t, status: "awaiting_approval" as const, proposal, updatedAt: new Date().toISOString() }
          : t,
      ),
    };
  });
  if (!next) throw new ProviderHttpError(404, "not_found", "会话不存在");
  return { session: next, turn: next.turns!.find((t) => t.id === turnId)!, assistant: proposalMessage };
}

/**
 * 批准一条提案：按报价快照逐条建任务。
 *
 * 幂等：重复批准（含并发双按、网络重试、崩溃后重进）靠两层兜住——会话锁内只对
 * `awaiting_approval` 翻 `executing`；每个 action 的幂等键 `agent:<turnId>:<i>`
 * 让重放的 `createJob` 交回同一条任务而不是再建一条。
 */
export async function approveTurn(ownerId: string, sessionId: string, turnId: string): Promise<RunTurnResult> {
  const current = await readSession(ownerId, sessionId);
  if (!current) throw new ProviderHttpError(404, "not_found", "会话不存在");
  const turn = current.turns?.find((t) => t.id === turnId);
  if (!turn) throw new ProviderHttpError(404, "not_found", "轮次不存在");
  if (turn.status === "succeeded") {
    return { session: current, turn, assistant: findAssistant(current, turnId) };
  }
  if (turn.status === "rejected" || turn.status === "failed") {
    throw new ProviderHttpError(409, "conflict", "该提案已结束，不能批准");
  }
  if (!turn.proposal) throw new ProviderHttpError(409, "conflict", "该轮没有可批准的提案");
  if (turn.status === "thinking") {
    throw new ProviderHttpError(409, "conflict", "提案尚未就绪，请稍后再试");
  }
  if (Date.parse(turn.proposal.expiresAt) <= Date.now()) {
    throw new ProviderHttpError(409, "proposal_expired", "提案报价已过期，请重新发起一轮");
  }

  const imageProduct = current.imageProduct;
  const videoProduct = current.videoProduct;

  // 会话锁内：预算核对 + awaiting_approval → executing。并发第二次批准到这里时状态
  // 已经是 executing——直接放行去补跑剩下的 action（幂等键兜住重复创建）。
  const claimed = await updateSession(ownerId, sessionId, (s) => {
    const t = s.turns?.find((x) => x.id === turnId);
    if (!t) return undefined;
    if (t.status === "awaiting_approval") {
      if (s.budget && t.proposal && round2(s.budget.spentCny + t.proposal.totalCny) > s.budget.limitCny) {
        throw new ProviderHttpError(402, "budget_exhausted", "本会话预算已用完，可在会话设置里调高上限");
      }
      return {
        ...s,
        turns: s.turns!.map((x) =>
          x.id === turnId ? { ...x, status: "executing" as const, updatedAt: new Date().toISOString() } : x,
        ),
      };
    }
    return t.status === "executing" ? s : undefined;
  });
  const working = claimed?.turns?.find((t) => t.id === turnId);
  if (!working || working.status !== "executing") {
    throw new ProviderHttpError(409, "conflict", "该提案已结束，不能批准");
  }

  const jobs: AgentJobRef[] = [];
  for (let i = 0; i < working.proposal!.actions.length; i += 1) {
    const action = working.proposal!.actions[i];
    const entry = await createForAction(action, {
      ownerId,
      turnId,
      index: i,
      imageProduct,
      videoProduct,
    });
    jobs.push(entry);
    // 每建成一条就把 jobId 落进 turn：中途崩溃后重放能从下一条接着建，
    // 已建的那条由幂等键交回而不是再建。
    if (entry.jobId) {
      await updateSession(ownerId, sessionId, (s) =>
        s.turns?.some((t) => t.id === turnId && t.status === "executing" && !t.jobIds.includes(entry.jobId!))
          ? {
              ...s,
              jobIds: [...new Set([...s.jobIds, entry.jobId!])],
              turns: s.turns.map((t) =>
                t.id === turnId
                  ? { ...t, jobIds: [...t.jobIds, entry.jobId!], updatedAt: new Date().toISOString() }
                  : t,
              ),
            }
          : undefined,
      );
    }
  }

  // 收尾：turn 成功、助手消息换成「已批准 + 任务列表」、已花额计入任务价。
  const spent = round2(jobs.reduce((sum, j) => sum + (j.priceCny ?? 0), 0));
  const next = await updateSession(ownerId, sessionId, (s) => {
    const t = s.turns?.find((x) => x.id === turnId);
    if (!t || t.status !== "executing") return undefined;
    return {
      ...s,
      messages: s.messages.map((m) =>
        m.id === turnId ? { ...m, approval: "approved" as const, jobs } : m,
      ),
      turns: s.turns!.map((x) =>
        x.id === turnId ? { ...x, status: "succeeded" as const, updatedAt: new Date().toISOString() } : x,
      ),
      ...(s.budget && spent > 0 ? { budget: { ...s.budget, spentCny: round2(s.budget.spentCny + spent) } } : {}),
    };
  });
  if (!next) throw new ProviderHttpError(404, "not_found", "会话不存在");
  const done = next.turns!.find((t) => t.id === turnId)!;
  return { session: next, turn: done, assistant: findAssistant(next, turnId) };
}

/** 拒绝提案：持久化的终态，不创建任务、不退轮次费（对话本身已交付）。 */
export async function rejectTurn(ownerId: string, sessionId: string, turnId: string): Promise<RunTurnResult> {
  const current = await readSession(ownerId, sessionId);
  if (!current) throw new ProviderHttpError(404, "not_found", "会话不存在");
  const turn = current.turns?.find((t) => t.id === turnId);
  if (!turn) throw new ProviderHttpError(404, "not_found", "轮次不存在");
  if (turn.status === "rejected") {
    return { session: current, turn, assistant: findAssistant(current, turnId) };
  }
  if (turn.status !== "awaiting_approval") {
    throw new ProviderHttpError(409, "conflict", "该轮当前状态不能拒绝");
  }
  const next = await updateSession(ownerId, sessionId, (s) => {
    const t = s.turns?.find((x) => x.id === turnId);
    if (!t || t.status !== "awaiting_approval") return undefined;
    return {
      ...s,
      messages: s.messages.map((m) => (m.id === turnId ? { ...m, approval: "rejected" as const } : m)),
      turns: s.turns!.map((x) =>
        x.id === turnId ? { ...x, status: "rejected" as const, updatedAt: new Date().toISOString() } : x,
      ),
    };
  });
  if (!next) throw new ProviderHttpError(404, "not_found", "会话不存在");
  return {
    session: next,
    turn: next.turns!.find((t) => t.id === turnId)!,
    assistant: findAssistant(next, turnId),
  };
}

/**
 * 惰性结算「死掉的」thinking 轮次：发起它的那次请求超过 2 分钟没把提案写回来，
 * 就是进程重启 / 连接断了——先退款（`ref` 幂等），再标 failed。会话详情的每次
 * 读取都会走这里，所以一笔卡住的账最迟在下一次打开页面时了结。
 */
export async function settleStaleTurns(ownerId: string, session: AgentSession): Promise<AgentSession> {
  const stale = session.turns?.filter(
    (t) => t.status === "thinking" && Date.now() - Date.parse(t.updatedAt) > STALE_THINKING_MS,
  );
  if (!stale?.length) return session;
  for (const t of stale) {
    await refundTurn(ownerId, t.priceCny, t.chargeRef);
  }
  const refs = new Set(stale.map((t) => `${t.chargeRef}:refund`));
  const settled = await updateSession(ownerId, session.id, (s) => ({
    ...s,
    turns: s.turns!.map((t) =>
      refs.has(`${t.chargeRef}:refund`) && t.status === "thinking"
        ? {
            ...t,
            status: "failed" as const,
            refundRef: `${t.chargeRef}:refund`,
            error: { code: "stale", message: "请求中断，本轮费用已退回" },
            updatedAt: new Date().toISOString(),
          }
        : t,
    ),
    ...(s.budget
      ? {
          budget: {
            ...s.budget,
            spentCny: Math.max(0, round2(s.budget.spentCny - stale.reduce((sum, t) => sum + t.priceCny, 0))),
          },
        }
      : {}),
  }));
  return settled ?? session;
}

/**
 * 读单轮（刷新恢复用）：把 `thinking` / `executing` 的中途态交还给界面。
 * 顺带做惰性结算：`thinking` 挂太久的轮次 = 发起请求死了，退款并标 failed。
 */
export async function readTurn(ownerId: string, sessionId: string, turnId: string): Promise<{ turn: AgentTurn; session: AgentSession } | null> {
  const raw = await readSession(ownerId, sessionId);
  if (!raw) return null;
  const session = await settleStaleTurns(ownerId, raw);
  const turn = session.turns?.find((t) => t.id === turnId);
  return turn ? { turn, session } : null;
}

async function refundTurn(ownerId: string, priceCny: number, ref: string): Promise<void> {
  try {
    await applyBalanceChange(ownerId, priceCny, {
      kind: "adjust",
      amountCny: priceCny,
      ref: `${ref}:refund`,
      note: "智能体对话失败退回",
    }, { refundOf: ref });
  } catch (error) {
    // 退款失败不该盖掉「智能体挂了」这个真正的原因；记一条 warn 供人工对账。
    log("warn", "智能体退款失败", { ownerId, ref, error: String(error) });
  }
}

/**
 * 提案报价：按这条动作将要走的 mode 用价表算一个数。它是**快照**不是合约——
 * 真扣款由 `createJob` 按路由后的实际档位算，两个数可能有差（产品路由换家、
 * 档位归一）；批准以这个数为预期，界面上展示的是它。
 */
function quoteAction(action: AgentAction): number {
  if (action.type === "image") {
    return priceCny({ mode: "text_to_image", imageResolution: "1k" });
  }
  return priceCny({
    mode: action.imageRef ? "image_to_video" : "text_to_video",
    durationSec: action.durationSec && ALLOWED_DURATIONS.has(action.durationSec) ? action.durationSec : 5,
  });
}

async function createForAction(
  action: AgentQuotedAction,
  ctx: {
    ownerId: string;
    turnId: string;
    index: number;
    imageProduct?: string;
    videoProduct?: string;
  },
): Promise<AgentJobRef> {
  const image = action.type === "image";
  // 用户在面板上点名的产品优先于模型挑的：他点的时候看到的是产品名和价格。
  const picked = image ? ctx.imageProduct : ctx.videoProduct;
  const model = usableProductId(picked, action.type) ?? usableProductId(action.product, action.type);
  const body: CreateJobBody = {
    mode: image ? "text_to_image" : action.imageRef ? "image_to_video" : "text_to_video",
    prompt: action.prompt,
    ...(model ? { model } : {}),
    ...(action.aspectRatio ? { aspectRatio: action.aspectRatio } : {}),
    // 资产引用（B 包）：首帧上传的归属与角色校验都在 createJob 的 sidecar 路径里，
    // 别人的 / 过期的 uploadId 会变成这条动作的 error，不会静默丢。
    ...(action.imageRef && !image ? { startUploadId: action.imageRef.uploadId } : {}),
    ...(image
      ? { imageResolution: "1k" as const }
      : action.durationSec && ALLOWED_DURATIONS.has(action.durationSec)
        ? { durationSec: action.durationSec }
        : {}),
    idempotencyKey: `agent:${ctx.turnId}:${ctx.index}`,
  };
  // 与 `POST /api/jobs` **同一个**限流桶（`@/lib/jobs/rate-limit`）：智能体绕过 HTTP
  // 直接调 `createJob`，不在这里消费的话，「让智能体一轮开两条 × 每分钟二十轮」就是
  // 那条限流的现成绕过路径。桶满只让这一条 action 落空（`error` 记码，文案由前端字典
  // 翻译），不让整轮失败——回复和别的 action 该照常出。
  const gate = consumeJobCreation(ctx.ownerId);
  if (!gate.allowed) {
    log("warn", "智能体创建任务被限流", { ownerId: ctx.ownerId, turnId: ctx.turnId, index: ctx.index });
    return { kind: action.type, prompt: action.prompt, priceCny: action.priceCny, error: "rate_limited" };
  }
  try {
    const { job } = await createJob(body, ctx.ownerId);
    return { jobId: job.id, kind: action.type, prompt: action.prompt, priceCny: action.priceCny };
  } catch (error) {
    const message =
      error instanceof ProviderHttpError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    log("warn", "智能体创建任务失败", { ownerId: ctx.ownerId, turnId: ctx.turnId, index: ctx.index, message });
    return { kind: action.type, prompt: action.prompt, priceCny: action.priceCny, error: message };
  }
}

/** 认不出、当下不可用、或类别对不上（拿图片产品去出视频）的产品 id 一律丢掉。 */
function usableProductId(id: string | undefined, type: AgentAction["type"]): string | undefined {
  if (!id) return undefined;
  const product = productById(id);
  if (!product) return undefined;
  if (product.kind !== type) return undefined;
  if (!isProductAvailable(product)) return undefined;
  return product.id;
}

/** 带进上下文的历史轮数（一问一答算两条）。太长既费钱也没用。 */
const HISTORY_MESSAGES = 12;

function buildMessages(
  session: AgentSession,
  text: string,
  skillPrompt: string | undefined,
  locale: Locale,
): AgentChatMessage[] {
  const language = locale === "en" ? "Write reply in English." : "reply 用中文。";
  const system = [
    BASE_SYSTEM_PROMPT,
    skillPrompt ? `\n本次技能约束：${skillPrompt}` : "",
    `\n${language}`,
    `\n可用产品：\n${productLines()}`,
  ]
    .filter(Boolean)
    .join("\n");
  const history = session.messages.slice(-HISTORY_MESSAGES).map<AgentChatMessage>((m) => ({
    role: m.role,
    content: m.text,
  }));
  return [{ role: "system", content: system }, ...history, { role: "user", content: text }];
}

/**
 * 交给模型的产品清单。只列 id / 名字 / 类别 / 画幅（视频再加时长档）——供应商名与上游
 * 模型名一个字都不出现，那条纪律对模型和对浏览器是一样的。
 */
function productLines(): string {
  const rows = availableProducts().map((p) => {
    const bits = [`${p.id}（${p.name}，${p.kind === "image" ? "图片" : "视频"}）`, `画幅 ${p.aspectRatios.join("/")}`];
    if (p.kind === "video" && p.durations?.length) bits.push(`时长 ${p.durations.join("/")}s`);
    return `- ${bits.join("，")}`;
  });
  return rows.length ? rows.join("\n") : "- （当前没有可用产品，actions 请给空数组）";
}
