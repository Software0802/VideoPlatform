import OpenAI from "openai";
import { z } from "zod";
import { agentLlmConfig } from "@/lib/agent/llm";
import { harnessLlmTimeoutMs, harnessQcVisualModel } from "@/lib/env";
import { HarnessFailure } from "./harness-failure";
import { normalizeCompletion, usageFromResponse, type LlmCompletion, type LlmUsage } from "./llm-usage";
import type { IdentityBible, Shot } from "./types";

/**
 * Visual consistency rubric (design.md §7.2 QC ③ / evals/rubric.md):
 * face, hair, wardrobe, lighting, palette, each 0–1, scored by the agent LLM's
 * vision model (`HARNESS_QC_VISUAL_MODEL` overrides the agent model when the
 * scorer needs a different upstream name).
 * The pass threshold is NOT fixed here — it must be calibrated against
 * evals/runs and supplied via HARNESS_QC_VISUAL_THRESHOLD (H2).
 */

export function visualQcModel(): string {
  const model = harnessQcVisualModel() ?? agentLlmConfig()?.model;
  if (!model) {
    throw new HarnessFailure("llm_unavailable", "缺少可用的对话模型（AGENT_API_KEY 或 XAI_API_KEY）");
  }
  return model;
}

export const visualQcScoreSchema = z
  .object({
    face: z.number().min(0).max(1),
    hair: z.number().min(0).max(1),
    wardrobe: z.number().min(0).max(1),
    lighting: z.number().min(0).max(1),
    palette: z.number().min(0).max(1),
    notes: z.string().max(1000),
  })
  .strict();

/**
 * `overall` is the five-way mean kept for the rubric's style score; `identity` is
 * min(face, hair, wardrobe) so a face swap cannot be averaged away by good lighting (R04).
 */
export type VisualQcScore = z.infer<typeof visualQcScoreSchema> & { overall: number; identity: number };

export type VisualQcFrame = { label: string; dataUri: string };

export type VisualQcContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type VisualQcRequest = {
  model: string;
  messages: [
    { role: "system"; content: string },
    { role: "user"; content: VisualQcContentPart[] },
  ];
  responseFormat: { type: "json_object" };
};

export type VisualQcCompleter = (request: VisualQcRequest) => Promise<string | LlmCompletion>;

const SYSTEM_PROMPT = `你是 Lumen 的一致性质检员。对照 Identity Bible 与参考帧（用户首帧、角色表、上一镜尾帧），给当前镜头抽出的首、中、尾三帧打分；任一帧漂移都按最差那帧计。
五个维度各 0–1（步长 0.1）：face 面部身份、hair 发型、wardrobe 服装、lighting 光线、palette 色调与风格。
1 表示与参考完全一致，0.5 表示大体相同但有明显漂移，0 表示换人 / 换装 / 风格断裂。
没有人物的镜头，face/hair/wardrobe 按场景主体的一致性评分。只输出符合下面 JSON Schema 的 JSON。

JSON Schema:
${JSON.stringify(z.toJSONSchema(visualQcScoreSchema))}`;

export function buildVisualQcRequest(input: {
  bible: IdentityBible;
  shot: Shot;
  references: VisualQcFrame[];
  frames: VisualQcFrame[];
  /** 默认取配置模型；注入 completer 的测试路径可显式给一个占位名。 */
  model?: string;
}): VisualQcRequest {
  const characters = input.shot.characterIds
    .map((id) => input.bible.characters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => `${c.name}：${c.lockedTraits.join("；")}`);
  const brief = [
    `Logline: ${input.bible.logline}`,
    `色板: ${input.bible.style.palette.join("、")}`,
    `光线: ${input.bible.style.lighting}`,
    `镜头语言: ${input.bible.style.lens}`,
    `不可改变: ${input.bible.style.doNotChange.join("；") || "无"}`,
    characters.length ? `角色锁定: ${characters.join(" / ")}` : "角色锁定: 无",
    `镜头 ${input.shot.index} 提示词: ${input.shot.prompt}`,
  ].join("\n");
  const content: VisualQcContentPart[] = [{ type: "text", text: brief }];
  for (const ref of input.references) {
    content.push({ type: "text", text: `参考: ${ref.label}` });
    content.push({ type: "image_url", image_url: { url: ref.dataUri } });
  }
  for (const frame of input.frames) {
    content.push({ type: "text", text: `待评: ${frame.label}` });
    content.push({ type: "image_url", image_url: { url: frame.dataUri } });
  }
  return {
    model: input.model ?? visualQcModel(),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    responseFormat: { type: "json_object" },
  };
}

export function parseVisualQcResponse(raw: string): VisualQcScore {
  const value: unknown = JSON.parse(raw);
  const parsed = visualQcScoreSchema.parse(value);
  const overall =
    (parsed.face + parsed.hair + parsed.wardrobe + parsed.lighting + parsed.palette) / 5;
  const identity = Math.min(parsed.face, parsed.hair, parsed.wardrobe);
  return { ...parsed, overall: Math.round(overall * 100) / 100, identity };
}

/** A shot passes visual QC only if both the style mean and the identity floor clear the threshold. */
export function visualQcPasses(score: Pick<VisualQcScore, "overall" | "identity">, threshold: number): boolean {
  return score.overall >= threshold && score.identity >= threshold;
}

export async function scoreVisualConsistency(
  input: Parameters<typeof buildVisualQcRequest>[0],
  options: { complete?: VisualQcCompleter; onUsage?: (usage: LlmUsage | null) => void | Promise<void> } = {},
): Promise<VisualQcScore> {
  const complete = options.complete ?? completerFor();
  // 注入 completer 的路径不要求真凭据，与 createDirectorPlan 同口径。
  const model = options.complete
    ? (harnessQcVisualModel() ?? agentLlmConfig()?.model ?? "qc-mock")
    : visualQcModel();
  const completion = normalizeCompletion(await complete(buildVisualQcRequest({ ...input, model })));
  // Same contract as the Director: null means "billed, but usage unknown".
  await options.onUsage?.(completion.usage ?? null);
  return parseVisualQcResponse(completion.content);
}

/** Retry prompt tightening: restate the locked traits so the regenerated shot drifts less. */
export function tightenShotPrompt(shot: Shot, bible: IdentityBible, attempt: number): string {
  if (attempt <= 0) return shot.prompt;
  const locks = [
    ...bible.style.doNotChange,
    ...shot.characterIds.flatMap((id) => {
      const c = bible.characters.find((x) => x.id === id);
      return c ? c.lockedTraits.map((t) => `${c.name}${t}`) : [];
    }),
  ];
  const suffix = locks.length
    ? `严格保持不变：${locks.join("；")}。光线 ${bible.style.lighting}，色板 ${bible.style.palette.join("、")}。`
    : `严格保持光线 ${bible.style.lighting} 与色板 ${bible.style.palette.join("、")} 不变。`;
  return `${shot.prompt}\n${suffix}`.slice(0, 2000);
}

function completerFor(): VisualQcCompleter {
  const config = agentLlmConfig();
  if (!config) {
    throw new HarnessFailure("llm_unavailable", "缺少可用的对话模型（AGENT_API_KEY 或 XAI_API_KEY）");
  }
  if (config.provider === "mock") {
    return async () => { throw new HarnessFailure("llm_unavailable", "mock 实例没有真实对话上游"); };
  }
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: harnessLlmTimeoutMs(),
  });
  return (request) => completeWithAgent(client, request);
}

async function completeWithAgent(client: OpenAI, request: VisualQcRequest): Promise<LlmCompletion> {
  const response = await client.chat.completions.create({
    model: request.model,
    messages: request.messages,
    response_format: request.responseFormat,
    temperature: 0,
  });
  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("视觉 QC 未返回内容");
  }
  return { content, usage: usageFromResponse(response.usage) };
}
