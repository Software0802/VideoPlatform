import { assertBalance } from "@/lib/billing/admission";
import { applyBalanceChange, hasEntryFor } from "@/lib/billing/ledger";
import { agentTurnPriceCny } from "@/lib/billing/prices";
import { log } from "@/lib/log";
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
  type AgentSession,
  type AgentTier,
} from "@/lib/agent/schema";
import { agentSkillById } from "@/lib/agent/skills";
import { appendTurn, newMessageId, readSession } from "@/lib/agent/store";

/**
 * 一轮对话（方案 §1）。
 *
 * 顺序是**先扣钱、再调用、再建任务**，理由和任务那边的「先扣后写」是同一条：一次
 * LLM 调用一旦发出就已经花掉了，把扣款放在它后面等于开一个「崩了就白送一次」的窗口。
 * 幂等键 `agent:<turnId>` 由 `applyBalanceChange` 扫流水去重，所以重放不会重复扣。
 *
 * 反过来，调用**整个失败**（三次都没拿到合法回复、上游挂了）时把这一轮退回去：
 * 「上游挂了不该用户掏钱」在任务那边是不扣款，在这里就得是退款，因为钱已经扣了。
 * 退款走同一个 `applyBalanceChange`（`kind:"adjust"`，`ref` 加 `:refund` 后缀），
 * 不另写一份扣款逻辑——AGENTS.md 的硬约束。
 *
 * 一轮里某个 action 建任务失败（余额不够再开一条、参数被 400）不算整轮失败：那条
 * 写进消息的 `jobs[i].error`，别的照常出。用户该看到「这条为什么没出来」，而不是
 * 因为第二条参数不对就连回复都没有。
 */

const BASE_SYSTEM_PROMPT = `你是 Genius 的创作智能体。用户用一句话说出想法，你负责把它变成可以直接下单的生成请求。

规则：
1. 只输出 JSON，形状是 {"reply": string, "actions": Action[]}，不要 Markdown 代码块，不要任何解释文字。
2. reply 用中文，两到四句，说清你理解的画面方向和这次要生成什么。不要重复用户原话，不要列清单。
3. actions 最多 ${MAX_ACTIONS_PER_TURN} 条；用户只是在聊天、提问或信息不足时给空数组。
4. Action 形状：{"type":"image"|"video","prompt":string,"aspectRatio"?:string,"durationSec"?:number,"product"?:string}。
5. prompt 用中文写给生成模型看：一句可拍的场景 + 一个明确的镜头运动或构图 + 光线与色温 + 一句显式的"保持 X 不变"锁定项。锁定项写具体可检的事物（发型长度、服装颜色、光向、色板），不写抽象形容词。
6. aspectRatio 只能是 16:9、9:16、1:1、4:3、3:4、3:2、2:3 之一；durationSec 只能是 5 或 10。
7. product 只能填下面「可用产品」里的 id，拿不准就不填，由服务端按用户当前配置选。`;

/** 服务端认的时长档。LLM 给别的值就丢掉，让服务端按默认走——不让一句话把任务推进长片管线。 */
const ALLOWED_DURATIONS = new Set([5, 10]);

export type RunTurnOptions = {
  /** 测试接缝：不传就按「哪家有 key」选提供方（都没有则 mock）。 */
  complete?: AgentCompleter;
  config?: AgentLlmConfig;
};

export type RunTurnResult = {
  session: AgentSession;
  assistant: AgentMessage;
};

export async function runTurn(
  session: AgentSession,
  input: {
    ownerId: string;
    text: string;
    skillId?: string;
    tier?: AgentTier;
    imageProduct?: string;
    videoProduct?: string;
    /** 一轮的稳定身份（R08）：HTTP 重试原样带回，扣款 / 建任务 / 写消息全部按它幂等。 */
    turnId?: string;
  },
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const ownerId = input.ownerId;
  const turnId = input.turnId ?? newMessageId();
  const ref = `agent:${turnId}`;

  // R08：调用方带 turnId 时先按它查重——这条轮次可能整个跑完过、只是回执丢在了
  // 网络上。会话里已有同 id 的 assistant 消息 = 这轮已经成交：原文本一致就把当时
  // 的答复原样交回，不再扣钱、不再调 LLM；文本不同说明同一个 key 被复用到另一句话
  // 上，那是参数冲突，按 409 拒绝而不是沉默交回旧答复。
  if (input.turnId) {
    const fresh = await readSession(ownerId, session.id);
    if (!fresh) throw new ProviderHttpError(404, "not_found", "会话不存在");
    const idx = fresh.messages.findIndex((m) => m.role === "assistant" && m.id === turnId);
    if (idx >= 0) {
      const prior = fresh.messages[idx - 1];
      if (!prior || prior.role !== "user" || prior.text !== input.text) {
        throw new ProviderHttpError(
          409,
          "idempotency_conflict",
          "同一轮次键被用于不同的输入，请重新发起",
        );
      }
      return { session: fresh, assistant: fresh.messages[idx] };
    }
    // 同 turnId 的一轮以前跑过、但 LLM 整轮失败退了款：扣款行与退款行都已落账，
    // 再走一遍的话扣款被幂等跳过、LLM 却真的又调了——等于白送一轮。这不是重放，
    // 是一次已被结算过的失败请求被原样重发；显式拒绝，客户端要重试就换 key。
    if (await hasEntryFor(ownerId, "adjust", `${ref}:refund`)) {
      throw new ProviderHttpError(
        409,
        "idempotency_conflict",
        "这一轮已经失败退款，请重新发起",
      );
    }
    session = fresh;
  }
  // 一家可用的对话提供方都没有时到此为止，而且必须在扣款**之前**：先扣再退会在流水上
  // 留下一对无意义的进出，用户却什么都没拿到。注入了替身的调用（测试）不需要真凭据。
  if (!options.complete && !options.config) requireAgentLlmConfig();
  const tier = input.tier ?? session.tier ?? "balanced";
  const skillId = input.skillId ?? session.skillId;
  const skill = agentSkillById(skillId);
  const imageProduct = input.imageProduct ?? session.imageProduct;
  const videoProduct = input.videoProduct ?? session.videoProduct;

  const turnPrice = agentTurnPriceCny();
  const userMessage: AgentMessage = {
    id: newMessageId(),
    role: "user",
    text: input.text,
    ...(skill ? { skillId: skill.id } : {}),
    at: new Date().toISOString(),
  };

  // 判定与扣款必须在同一个 `withAdmissionLock` 临界区里（AGENTS.md 硬约束）：出了锁，
  // 并发的两轮会读到同一份「还够一次」的余额然后一起放行。
  if (turnPrice > 0) {
    await withAdmissionLock(async () => {
      await assertBalance(ownerId, turnPrice);
      await applyBalanceChange(ownerId, -turnPrice, {
        kind: "charge",
        amountCny: -turnPrice,
        ref,
        note: "智能体对话",
      });
    });
  }

  let reply: Awaited<ReturnType<typeof completeAgentTurn>>;
  try {
    reply = await completeAgentTurn({
      messages: buildMessages(session, input.text, skill?.systemPrompt),
      tier,
      complete: options.complete,
      config: options.config,
    });
  } catch (error) {
    if (turnPrice > 0) await refundTurn(ownerId, turnPrice, ref);
    throw error instanceof ProviderHttpError
      ? error
      : new ProviderHttpError(502, "agent_unavailable", "智能体暂时无法回复，本轮费用已退回");
  }

  const jobs: AgentJobRef[] = [];
  const jobIds: string[] = [];
  const actions = reply.actions.slice(0, MAX_ACTIONS_PER_TURN);
  for (let i = 0; i < actions.length; i += 1) {
    const entry = await createForAction(actions[i], {
      ownerId,
      turnId,
      index: i,
      imageProduct,
      videoProduct,
    });
    jobs.push(entry);
    if (entry.jobId) jobIds.push(entry.jobId);
  }

  const assistant: AgentMessage = {
    id: turnId,
    role: "assistant",
    text: reply.reply,
    ...(skill ? { skillId: skill.id } : {}),
    ...(jobs.length ? { jobs } : {}),
    priceCny: turnPrice,
    at: new Date().toISOString(),
  };

  // 锁内重读会话再追加：LLM 那几秒里另一轮可能已经写进去了，拿旧副本回写会抹掉它。
  const next = await appendTurn(ownerId, session.id, [userMessage, assistant], jobIds, {
    ...(skill ? { skillId: skill.id } : {}),
    tier,
    ...(imageProduct ? { imageProduct } : {}),
    ...(videoProduct ? { videoProduct } : {}),
  });
  if (!next) {
    // 会话在这一轮跑的过程中被删了。钱花了（LLM 真的调用过），任务也真的建了，
    // 所以不退款；调用方回 404，用户看到的是「这个会话没了」，那正是事实。
    throw new ProviderHttpError(404, "not_found", "会话不存在");
  }
  return { session: next, assistant };
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

async function createForAction(
  action: AgentAction,
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
    mode: image ? "text_to_image" : "text_to_video",
    prompt: action.prompt,
    ...(model ? { model } : {}),
    ...(action.aspectRatio ? { aspectRatio: action.aspectRatio } : {}),
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
    return { kind: action.type, prompt: action.prompt, error: "rate_limited" };
  }
  try {
    const { job } = await createJob(body, ctx.ownerId);
    return { jobId: job.id, kind: action.type, prompt: action.prompt };
  } catch (error) {
    const message =
      error instanceof ProviderHttpError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    log("warn", "智能体创建任务失败", { ownerId: ctx.ownerId, turnId: ctx.turnId, index: ctx.index, message });
    return { kind: action.type, prompt: action.prompt, error: message };
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
): AgentChatMessage[] {
  const system = [BASE_SYSTEM_PROMPT, skillPrompt ? `\n本次技能约束：${skillPrompt}` : "", `\n可用产品：\n${productLines()}`]
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
