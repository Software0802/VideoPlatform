import OpenAI from "openai";
import { z } from "zod";
import { grokApiKey, upstreamTimeoutMs, xaiBase } from "@/lib/env";
import type { IdentityBible, Shot } from "./types";

/**
 * Visual consistency rubric (design.md §7.2 QC ③ / evals/rubric.md):
 * face, hair, wardrobe, lighting, palette, each 0–1, scored by grok-4.6 vision.
 * The pass threshold is NOT fixed here — it must be calibrated against
 * evals/runs and supplied via HARNESS_QC_VISUAL_THRESHOLD (H2).
 */

export const VISUAL_QC_MODEL = "grok-4.6";

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

export type VisualQcScore = z.infer<typeof visualQcScoreSchema> & { overall: number };

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
  responseFormat: {
    type: "json_schema";
    json_schema: { name: string; strict: true; schema: Record<string, unknown> };
  };
};

export type VisualQcCompleter = (request: VisualQcRequest) => Promise<string>;

const SYSTEM_PROMPT = `你是 Lumen 的一致性质检员。对照 Identity Bible 与参考帧，给当前镜头的首帧与尾帧打分。
五个维度各 0–1（步长 0.1）：face 面部身份、hair 发型、wardrobe 服装、lighting 光线、palette 色调与风格。
1 表示与参考完全一致，0.5 表示大体相同但有明显漂移，0 表示换人 / 换装 / 风格断裂。
没有人物的镜头，face/hair/wardrobe 按场景主体的一致性评分。只输出 JSON。`;

export function buildVisualQcRequest(input: {
  bible: IdentityBible;
  shot: Shot;
  references: VisualQcFrame[];
  frames: VisualQcFrame[];
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
    model: VISUAL_QC_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "lumen_visual_qc",
        strict: true,
        schema: z.toJSONSchema(visualQcScoreSchema) as Record<string, unknown>,
      },
    },
  };
}

export function parseVisualQcResponse(raw: string): VisualQcScore {
  const value: unknown = JSON.parse(raw);
  const parsed = visualQcScoreSchema.parse(value);
  const overall =
    (parsed.face + parsed.hair + parsed.wardrobe + parsed.lighting + parsed.palette) / 5;
  return { ...parsed, overall: Math.round(overall * 100) / 100 };
}

export async function scoreVisualConsistency(
  input: Parameters<typeof buildVisualQcRequest>[0],
  options: { complete?: VisualQcCompleter } = {},
): Promise<VisualQcScore> {
  const complete = options.complete ?? completeWithGrok;
  const raw = await complete(buildVisualQcRequest(input));
  return parseVisualQcResponse(raw);
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

async function completeWithGrok(request: VisualQcRequest): Promise<string> {
  const apiKey = grokApiKey();
  if (!apiKey) throw new Error("缺少 XAI_API_KEY 或 SUB2API_API_KEY");
  const client = new OpenAI({
    apiKey,
    baseURL: xaiBase(),
    maxRetries: 0,
    timeout: upstreamTimeoutMs(),
  });
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
  return content;
}
