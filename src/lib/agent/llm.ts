import OpenAI from "openai";
import {
  agentApiKey,
  agentBase,
  agentChatModel,
  grokApiKey,
  isMockMode,
  upstreamTimeoutMs,
  xaiBase,
} from "@/lib/env";
import { log } from "@/lib/log";
import { ProviderHttpError } from "@/lib/providers/types";
import {
  MAX_ACTIONS_PER_TURN,
  agentReplySchema,
  type AgentReply,
  type AgentTier,
} from "@/lib/agent/schema";

/**
 * 智能体的文本模型客户端（方案 §1，2026-09-07 收窄）。
 *
 * 提供方顺序只有三档：mock 实例 → `AGENT_API_KEY` → `XAI_API_KEY`。生图那几把 key
 * **不再**参与——生产上的 `OPENAI_BASE_URL`（ccgoai）与 `YMAN_API_KEY` 都是只出图的
 * 中转，`/chat/completions` 分别回 503 与 400，把它们排进来的结果是每一轮都「扣款 →
 * 失败 → 退款」，用户看到的只有一个错。
 *
 * 两把都没有就是**不可用**：`agentLlmConfig()` 返回 `null`，API 在扣款之前回 503
 * `agent_unavailable`。刻意不静默落 mock——一台没配对话 key 的生产实例应该说「智能体
 * 暂未开放」，而不是拿本地替身冒充在思考。mock 只在 `isMockMode()`（含
 * `LUMEN_FORCE_MOCK`）时出现，那正是开发与 e2e 的场景。
 *
 * 模型名固定默认（`AGENT_API_KEY` 那条 `gpt-4o-mini`，xAI `grok-4.6`），
 * `AGENT_CHAT_MODEL` 是唯一覆盖口。
 */

export const DEFAULT_AGENT_MODEL = "gpt-4o-mini";
export const DEFAULT_AGENT_MODEL_XAI = "grok-4.6";

/** 输出无效时最多再试几次（含首次共 3 次）。与 `harness/director.ts` 同一个口径。 */
const MAX_ATTEMPTS = 3;

export type AgentLlmProvider = "agent" | "xai" | "mock";

export type AgentLlmConfig = {
  provider: AgentLlmProvider;
  model: string;
  apiKey?: string;
  baseURL?: string;
};

/** 当前实例的对话提供方；`null` = 一家都没有，智能体不可用。 */
export function agentLlmConfig(): AgentLlmConfig | null {
  const override = agentChatModel();
  // 「这台实例用 mock 回答一切」对话不该是例外——否则一次 e2e 就会拿真 key 去说话。
  // 它在最前面，先于任何 key 判定。
  if (isMockMode()) return { provider: "mock", model: override ?? "mock-agent" };
  const agent = agentApiKey();
  if (agent) {
    return { provider: "agent", model: override ?? DEFAULT_AGENT_MODEL, apiKey: agent, baseURL: agentBase() };
  }
  const xai = grokApiKey();
  if (xai) {
    return { provider: "xai", model: override ?? DEFAULT_AGENT_MODEL_XAI, apiKey: xai, baseURL: xaiBase() };
  }
  return null;
}

/** 前端据此把输入卡置灰（`GET /api/agent/skills` 的 `available`）。 */
export function agentAvailable(): boolean {
  return agentLlmConfig() !== null;
}

/**
 * 取配置，不可用就抛 503。调用点必须在**扣款之前**——先扣再退会在流水上留下一对
 * 无意义的进出，而用户从头到尾没得到任何东西。
 */
export function requireAgentLlmConfig(): AgentLlmConfig {
  const config = agentLlmConfig();
  if (!config) throw new ProviderHttpError(503, "agent_unavailable", "智能体暂未开放");
  return config;
}

export type AgentChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type AgentCompletionRequest = {
  model: string;
  messages: AgentChatMessage[];
  temperature: number;
  maxTokens: number;
};

/** 测试与 mock 的接缝：真实调用之外的一切都从这里替换，不必去 stub `openai` 包。 */
export type AgentCompleter = (request: AgentCompletionRequest) => Promise<string>;

/**
 * 三档「文本模型」（原型里那个下拉）真正映射到的东西：温度与输出上限。
 * 用户看到的是「极速 / 均衡 / 精创」，不是模型名——模型是我们的实现细节。
 */
export const TIER_SETTINGS: Record<AgentTier, { temperature: number; maxTokens: number }> = {
  fast: { temperature: 0.3, maxTokens: 700 },
  balanced: { temperature: 0.7, maxTokens: 1000 },
  quality: { temperature: 1.0, maxTokens: 1400 },
};

/**
 * 跑一轮：拿到符合契约的 `{ reply, actions }`，或抛。
 *
 * 输出无效（不是 JSON、字段对不上）时最多再试 2 次，每次把「上一次错在哪」追加成一条
 * 用户消息——不是重发同样的请求。三次都不行就抛，由调用方决定怎么回。
 */
export async function completeAgentTurn(opts: {
  messages: AgentChatMessage[];
  tier: AgentTier;
  complete?: AgentCompleter;
  config?: AgentLlmConfig;
}): Promise<AgentReply> {
  // 注入了 completer 就不需要真实凭据（测试与替身路径）；否则必须有一家可用的提供方，
  // 没有就在这里抛 503——但正常路径上 `runTurn` 已经在扣款之前判过一次了。
  const config =
    opts.config ??
    (opts.complete ? { provider: "mock" as const, model: agentChatModel() ?? "mock-agent" } : requireAgentLlmConfig());
  const complete = opts.complete ?? (config.provider === "mock" ? mockCompleter : completerFor(config));
  const settings = TIER_SETTINGS[opts.tier];
  let messages = opts.messages;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const raw = await complete({
      model: config.model,
      messages,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    });
    const parsed = agentReplySchema.safeParse(extractJson(raw));
    if (parsed.success) {
      return { ...parsed.data, actions: parsed.data.actions.slice(0, MAX_ACTIONS_PER_TURN) };
    }
    lastError = parsed.error;
    log("warn", "智能体回复不符合契约，重试", {
      attempt: attempt + 1,
      provider: config.provider,
      issue: parsed.error.issues[0]?.message,
    });
    messages = [
      ...messages,
      {
        role: "user",
        content: '上一次回复不是合法的 JSON 或字段不符合契约。只输出 {"reply": string, "actions": []} 形状的 JSON，不要 Markdown 代码块，不要解释。',
      },
    ];
  }
  throw new Error("智能体未能给出合法回复", {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

function completerFor(config: AgentLlmConfig): AgentCompleter {
  return async (request) => {
    if (!config.apiKey) throw new Error("智能体缺少上游 key");
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      // 一次对话调用已经计费，重发只会再花一次钱；重试由上面那层按「输出无效」决定。
      maxRetries: 0,
      timeout: upstreamTimeoutMs(),
    });
    const response = await client.chat.completions.create({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      // 不用 `json_schema`：中转站对它的支持参差不齐，一家不认就整条通道不可用。
      // `json_object` 是最低公分母，形状仍由本地 zod 说了算。
      response_format: { type: "json_object" },
    });
    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("智能体未返回内容");
    return content;
  };
}

/* ── mock ───────────────────────────────────────────────────────────────── */

const IMAGE_HINTS = ["图", "图片", "海报", "插画", "image", "poster", "picture"];
const VIDEO_HINTS = ["视频", "分镜", "短片", "片子", "video", "clip", "storyboard"];

/**
 * 没有任何 key 时的确定性替身。**不随机**：同样的输入永远同样的输出，e2e 与本地开发
 * 才能对着它写断言。判据只看用户最后一句话里有没有图 / 视频的字眼。
 */
export const mockCompleter: AgentCompleter = async (request) => {
  const last = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = last.trim();
  const lower = text.toLowerCase();
  const wantsImage = IMAGE_HINTS.some((h) => lower.includes(h));
  const wantsVideo = VIDEO_HINTS.some((h) => lower.includes(h));
  const actions: AgentReply["actions"] = [];
  if (wantsImage) {
    actions.push({ type: "image", prompt: `${text}，构图干净，光线柔和，保持主体配色不变`, aspectRatio: "16:9" });
  }
  if (wantsVideo) {
    actions.push({
      type: "video",
      prompt: `${text}，镜头缓慢推近，暖调侧光，保持人物造型与色调不变`,
      aspectRatio: "16:9",
      durationSec: 5,
    });
  }
  const reply = actions.length
    ? `我按你的想法整理了画面方向，提案里有 ${actions.length} 条内容，批准后就开始生成。`
    : "我记下了这个想法。再说一句你想要图片还是视频，我就给你提案。";
  return JSON.stringify({ reply, actions: actions.slice(0, MAX_ACTIONS_PER_TURN) });
};

/**
 * 模型时不时会把 JSON 包在 ```json 代码块里，或在前面写一句「好的，」。
 * 先剥代码块，再退回「第一个 `{` 到最后一个 `}`」——比直接 `JSON.parse` 少一次无谓重试。
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text, sliceBraces(text)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function sliceBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
