import OpenAI from "openai";
import { z } from "zod";
import { grokApiKey, upstreamTimeoutMs, xaiBase } from "@/lib/env";
import type { HarnessPlan } from "./types";

export const DIRECTOR_MODEL = "grok-4.6";
const MAX_ATTEMPTS = 3;

const targetDurationSchema = z.union([z.literal(30), z.literal(45), z.literal(60)]);
const frameRefSchema = z
  .object({
    source: z.enum(["user", "generated", "extracted"]),
    assetId: z.string().trim().min(1).max(160),
  })
  .strict();

const identityBibleShapeSchema = z
  .object({
    version: z.literal(1),
    logline: z.string().trim().min(1).max(1000),
    style: z
      .object({
        palette: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
        lighting: z.string().trim().min(1).max(500),
        lens: z.string().trim().min(1).max(160),
        era: z.string().trim().min(1).max(160),
        doNotChange: z.array(z.string().trim().min(1).max(200)).max(32),
      })
      .strict(),
    characters: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            name: z.string().trim().min(1).max(160),
            lockedTraits: z.array(z.string().trim().min(1).max(200)).max(32),
            sheetAssetIds: z.array(z.string().trim().min(1).max(160)).max(16),
            voiceId: z.string().trim().min(1).max(80).optional(),
          })
          .strict(),
      )
      .max(24),
    locations: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            name: z.string().trim().min(1).max(160),
            refAssetIds: z.array(z.string().trim().min(1).max(160)).max(16),
          })
          .strict(),
      )
      .max(24),
    props: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            name: z.string().trim().min(1).max(160),
            refAssetIds: z.array(z.string().trim().min(1).max(160)).max(16),
          })
          .strict(),
      )
      .max(24),
  })
  .strict();

const shotShapeSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    index: z.number().int().min(0).max(999),
    durationSec: z.number().int().min(1).max(15),
    prompt: z.string().trim().min(1).max(2000),
    characterIds: z.array(z.string().trim().min(1).max(80)).max(24),
    locationId: z.string().trim().min(1).max(80).optional(),
    startFrame: frameRefSchema.optional(),
    endFrame: frameRefSchema.optional(),
    route: z.enum([
      "grok_t2v",
      "grok_i2v",
      "grok_r2v",
      "grok_extend",
      "jimeng_first_last",
    ]),
    continuity: z.enum(["hard_cut", "tail_chain", "extend"]),
    generateAudio: z.boolean(),
  })
  .strict();

const clipShapeSchema = z
  .object({
    kind: z.enum(["generate", "extend"]),
    durationSec: z.number().int().min(1).max(15),
  })
  .strict();

const directorPlanShapeSchema = z
  .object({
    targetDurationSec: targetDurationSchema,
    packing: z.object({ clips: z.array(clipShapeSchema).min(1).max(32) }).strict(),
    bible: identityBibleShapeSchema,
    shots: z.array(shotShapeSchema).min(1).max(64),
    stitch: z
      .object({
        // Phase 1/2 currently has only the hard-cut ffmpeg implementation.
        // Do not let the Director emit a plan that stitchClips cannot run.
        transition: z.literal("hard_cut"),
        settleLastFrame: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const directorPlanSchema = directorPlanShapeSchema.superRefine((plan, ctx) => {
  const packedDuration = plan.packing.clips.reduce((sum, clip) => sum + clip.durationSec, 0);
  if (packedDuration !== plan.targetDurationSec) {
    ctx.addIssue({
      code: "custom",
      path: ["packing", "clips"],
      message: "packing 时长必须等于目标时长",
    });
  }
  for (const [index, clip] of plan.packing.clips.entries()) {
    if (clip.kind === "extend" && clip.durationSec > 10) {
      ctx.addIssue({
        code: "custom",
        path: ["packing", "clips", index, "durationSec"],
        message: "extend 单段最长 10 秒",
      });
    }
  }

  const orderedIndexes = plan.shots.map((shot) => shot.index);
  const indexesAreContiguous = orderedIndexes.every((value, index) => value === index);
  if (!indexesAreContiguous) {
    ctx.addIssue({ code: "custom", path: ["shots"], message: "shot index 必须从 0 连续递增" });
  }
  const shotDuration = plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
  if (shotDuration !== plan.targetDurationSec) {
    ctx.addIssue({
      code: "custom",
      path: ["shots"],
      message: "shot 时长必须等于目标时长",
    });
  }
  for (const [index, shot] of plan.shots.entries()) {
    if (shot.route === "grok_extend" && shot.continuity !== "extend") {
      ctx.addIssue({
        code: "custom",
        path: ["shots", index, "continuity"],
        message: "grok_extend 必须使用 extend 连续性",
      });
    }
    if (shot.continuity === "extend" && shot.route !== "grok_extend") {
      ctx.addIssue({
        code: "custom",
        path: ["shots", index, "route"],
        message: "extend 连续性必须使用 grok_extend 路由",
      });
    }
  }
});

export type DirectorPlan = z.infer<typeof directorPlanSchema>;

const directorInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    targetDurationSec: targetDurationSchema,
    language: z.enum(["zh", "en"]).default("zh"),
    hasStartFrame: z.boolean().default(false),
    hasLastFrame: z.boolean().default(false),
    referenceAssetIds: z.array(z.string().trim().min(1).max(160)).max(7).default([]),
  })
  .strict();

export type DirectorInput = z.input<typeof directorInputSchema>;

export type DirectorCompletionRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  responseFormat: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    };
  };
};

export type DirectorCompleter = (request: DirectorCompletionRequest) => Promise<string>;

const directorJsonSchema = z.toJSONSchema(directorPlanShapeSchema) as Record<string, unknown>;
export const DIRECTOR_RESPONSE_FORMAT: DirectorCompletionRequest["responseFormat"] = {
  type: "json_schema",
  json_schema: {
    name: "lumen_harness_plan",
    strict: true,
    schema: directorJsonSchema,
  },
};

const DIRECTOR_SYSTEM_PROMPT = `你是 Lumen 的 Director。把用户创意拆成身份一致的连续视频计划。
只输出符合 lumen_harness_plan JSON Schema 的 JSON，不要 Markdown，不要解释。
目标视频只能是 30、45 或 60 秒；每个 generate 片段最多 15 秒，每个 extend 片段最多 10 秒。
优先使用 grok_i2v、grok_r2v 和 grok_extend；连续动作使用 extend，镜头切换使用 hard_cut 或 tail_chain；stitch.transition 只能是 hard_cut。
Identity Bible 必须把人物、服装、光线、色板和镜头语言写成可复用的锁定约束。`;

export async function createDirectorPlan(
  input: DirectorInput,
  options: { complete?: DirectorCompleter } = {},
): Promise<HarnessPlan> {
  const parsedInput = directorInputSchema.safeParse(input);
  if (!parsedInput.success) throw new Error("Director 输入无效");

  const complete = options.complete ?? completeWithGrok;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const request = buildRequest(parsedInput.data, attempt > 0);
    let raw: string;
    try {
      raw = await complete(request);
    } catch (error) {
      // The upstream client owns transport retries; do not duplicate billable calls here.
      throw error;
    }
    try {
      const value: unknown = JSON.parse(raw);
      return directorPlanSchema.parse(value) as HarnessPlan;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Director 输出无效", {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

function buildRequest(input: z.output<typeof directorInputSchema>, retry: boolean): DirectorCompletionRequest {
  const brief = [
    `目标时长: ${input.targetDurationSec} 秒`,
    `语言: ${input.language}`,
    `用户首帧: ${input.hasStartFrame ? "有，第一镜应引用 user_start" : "无"}`,
    `用户尾帧: ${input.hasLastFrame ? "有，最后一镜记录 endFrame；Grok-only 不承诺硬锁" : "无"}`,
    `参考资产: ${input.referenceAssetIds.length ? input.referenceAssetIds.join(", ") : "无"}`,
    `创意: ${input.prompt}`,
    retry ? "上一次计划未通过严格校验，请重新生成完整 JSON。" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    model: DIRECTOR_MODEL,
    messages: [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      { role: "user", content: brief },
    ],
    responseFormat: DIRECTOR_RESPONSE_FORMAT,
  };
}

async function completeWithGrok(request: DirectorCompletionRequest): Promise<string> {
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
    temperature: 0.2,
  });
  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Director 未返回内容");
  }
  return content;
}
