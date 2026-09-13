import OpenAI from "openai";
import { z } from "zod";
import { agentLlmConfig } from "@/lib/agent/llm";
import { harnessLlmTimeoutMs } from "@/lib/env";
import { HarnessFailure } from "./harness-failure";
import { normalizeCompletion, usageFromResponse, type LlmCompletion, type LlmUsage } from "./llm-usage";
import type { HarnessPlan } from "./types";

/**
 * Director 用智能体的对话配置（AGENT_API_KEY → xAI 回落），不再绑定某一个模型名。
 * 没有可用配置就是整条长片链路不可用，由调用方按 HarnessFailure 上报。
 */
export function directorModel(): string {
  const config = agentLlmConfig();
  if (!config) {
    throw new HarnessFailure("llm_unavailable", "缺少可用的对话模型（AGENT_API_KEY 或 XAI_API_KEY）");
  }
  return config.model;
}
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
    durationSec: z.union([z.literal(5), z.literal(10)]),
    prompt: z.string().trim().min(1).max(2000),
    characterIds: z.array(z.string().trim().min(1).max(80)).max(24),
    locationId: z.string().trim().min(1).max(80).optional(),
    startFrame: frameRefSchema.optional(),
    endFrame: frameRefSchema.optional(),
    route: z.enum(["t2v", "i2v", "r2v"]),
    continuity: z.enum(["hard_cut", "tail_chain"]),
    generateAudio: z.boolean(),
  })
  .strict();

const clipShapeSchema = z
  .object({
    kind: z.literal("generate"),
    durationSec: z.union([z.literal(5), z.literal(10)]),
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
    if (shot.continuity === "tail_chain" && shot.route === "t2v") {
      ctx.addIssue({
        code: "custom",
        path: ["shots", index, "route"],
        message: "tail_chain 连续性必须走 i2v / r2v",
      });
    }
    if (shot.route === "i2v" && shot.index > 0 && shot.continuity === "hard_cut" && !shot.startFrame) {
      ctx.addIssue({
        code: "custom",
        path: ["shots", index, "route"],
        message: "硬切后的 i2v 必须自带 startFrame",
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
  // `json_object` 而不是 `json_schema`：中转站对后者的支持参差不齐，形状由本地
  // zod 严格校验兜底，与 agent/llm.ts 同一个口径。
  responseFormat: { type: "json_object" };
};

export type DirectorCompleter = (request: DirectorCompletionRequest) => Promise<string | LlmCompletion>;

const directorJsonSchema = z.toJSONSchema(directorPlanShapeSchema) as Record<string, unknown>;
export const DIRECTOR_RESPONSE_FORMAT: DirectorCompletionRequest["responseFormat"] = {
  type: "json_object",
};

const DIRECTOR_SYSTEM_PROMPT = `你是 Lumen 的 Director。把用户创意拆成身份一致的连续视频计划。
只输出符合下面 JSON Schema 的 JSON，不要 Markdown，不要解释。
目标视频只能是 30、45 或 60 秒；每个 shot 与每个 packing 片段只能是 5 或 10 秒。
路由与连续性（供应商无关，具体 provider 由下游按能力适配）：
- 第一镜默认 t2v；用户给了首帧时第一镜用 i2v 并引用它。
- 后续镜头默认 tail_chain + i2v（拿上一镜尾帧续接，跨镜一致性最好）。
- 场景切换用 hard_cut + t2v；换了场景的接续镜不要接上一镜尾帧。
- 需要角色参考图驱动的镜头用 r2v，并在 characterIds 里点名对应角色。
- stitch.transition 只能是 hard_cut。
Identity Bible 必须把人物、服装、光线、色板和镜头语言写成可复用的锁定约束。

JSON Schema:
${JSON.stringify(directorJsonSchema)}`;

export async function createDirectorPlan(
  input: DirectorInput,
  options: { complete?: DirectorCompleter; onUsage?: (usage: LlmUsage | null) => void | Promise<void> } = {},
): Promise<HarnessPlan> {
  const parsedInput = directorInputSchema.safeParse(input);
  if (!parsedInput.success) throw new Error("Director 输入无效");

  // 模型在循环外定一次：重试不半路换家，usage 账目也按同一个名字记。
  // 注入了 completer 就不要求真凭据（测试与替身路径），与 completeAgentTurn 同口径。
  const complete = options.complete ?? completerFor();
  const model = options.complete ? (agentLlmConfig()?.model ?? "director-mock") : directorModel();
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const request = buildRequest(parsedInput.data, attempt > 0, model);
    let raw: string;
    try {
      const completion = normalizeCompletion(await complete(request));
      raw = completion.content;
      // A billable call that came back without usage is still reported (as null) so the
      // ledger can mark itself incomplete instead of silently under-counting (R-P1-2).
      await options.onUsage?.(completion.usage ?? null);
    } catch (error) {
      // The upstream client owns transport retries; do not duplicate billable calls here.
      // 超时 / 上游错误归一成 llm_upstream_failed：Director 不产生付费分镜，任务可重试，
      // 用户不该只看到一个裸的 "Request timed out."。
      if (error instanceof HarnessFailure) throw error;
      throw new HarnessFailure(
        "llm_upstream_failed",
        "导演规划超时或上游失败，未产生任何付费分镜，可重试",
      );
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

function buildRequest(
  input: z.output<typeof directorInputSchema>,
  retry: boolean,
  model: string,
): DirectorCompletionRequest {
  const brief = [
    `目标时长: ${input.targetDurationSec} 秒`,
    `语言: ${input.language}`,
    `用户首帧: ${input.hasStartFrame ? "有，第一镜应引用 user_start" : "无"}`,
    `用户尾帧: ${input.hasLastFrame ? "有，最后一镜记录 endFrame；上游不承诺硬锁" : "无"}`,
    `参考资产: ${input.referenceAssetIds.length ? input.referenceAssetIds.join(", ") : "无"}`,
    `创意: ${input.prompt}`,
    retry ? "上一次计划未通过严格校验，请重新生成完整 JSON。" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    model,
    messages: [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      { role: "user", content: brief },
    ],
    responseFormat: DIRECTOR_RESPONSE_FORMAT,
  };
}

function completerFor(): DirectorCompleter {
  const config = agentLlmConfig();
  if (!config) {
    throw new HarnessFailure("llm_unavailable", "缺少可用的对话模型（AGENT_API_KEY 或 XAI_API_KEY）");
  }
  if (config.provider === "mock") {
    // mock 实例不走 chat completions——orchestrator 在 mock provider 上用
    // mockDirectorPlan，本分支只兜住「director 被直接调到」的测试路径。
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

async function completeWithAgent(
  client: OpenAI,
  request: DirectorCompletionRequest,
): Promise<LlmCompletion> {
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
  return { content, usage: usageFromResponse(response.usage) };
}
