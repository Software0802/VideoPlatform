import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir, lumenRelaysRaw } from "@/lib/env";
import { log } from "@/lib/log";
import type { RelayModelSpec } from "@/lib/providers/relay/catalog";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";

/**
 * relay 配置的事实源：`data/relays.json`（`{schemaVersion:1, relays:[...]}`）。
 *
 * 三级来源，靠「谁更权威」排序而不是合并：
 *  1. 文件存在 → 以文件为准（管理接口写的就是它）；
 *  2. 文件不存在但有 `LUMEN_RELAYS` env → 解析作**首次种子**写入文件；
 *  3. 都没有 → 由老 env 折算（`YMAN_*` → yman 预设、`OPENAI_*` → openai 预设）——
 *     折算结果**不写文件**，保持「没人显式配置就跟随 env」的语义，生产 `.env`
 *     一行不用改。
 */

const RELAY_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]*$/;

/** 仍是代码内建、不可被 relay 抢占的 id（yman / openai 已是 relay 预设 id，不在其中）。 */
export const RESERVED_PROVIDER_IDS = ["grok", "mock", "jimeng", "kling"] as const;

const modelSpecSchema = z.object({
  aliases: z.array(z.string()).optional(),
  durations: z.array(z.number().positive()).optional(),
  resolutions: z.array(z.enum(["720p", "1080p"])).optional(),
  ratios: z.array(z.string()).optional(),
  maxReferenceImages: z.number().int().min(0).optional(),
  kind: z.enum(["video", "image", "chat"]).optional(),
  credits: z
    .object({
      resolution: z.record(z.string(), z.number().min(0)).optional(),
      duration: z.record(z.string(), z.number().min(0)).optional(),
      flat: z.number().min(0).optional(),
    })
    .optional(),
});

export const relayConfigSchema = z.object({
  id: z
    .string()
    .regex(RELAY_ID_RE, "id 须为小写字母开头的 slug（^[a-z][a-z0-9-]{1,31}$）")
    .refine((id) => !(RESERVED_PROVIDER_IDS as readonly string[]).includes(id), {
      message: "id 与内建 provider 冲突",
    }),
  name: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  keyEnv: z.string().regex(KEY_ENV_RE, "keyEnv 须为环境变量名（如 YMAN_API_KEY）"),
  enabled: z.boolean().default(true),
  priority: z.number().finite().default(0),
  creditsPerCny: z.number().positive().optional(),
  video: z
    .object({
      protocol: z.literal("openai-videos"),
      defaults: z.object({
        text_to_video: z.string().min(1).optional(),
        image_to_video: z.string().min(1).optional(),
        reference_to_video: z.string().min(1).optional(),
      }),
      taskTimeoutMs: z.number().positive().optional(),
    })
    .optional(),
  image: z
    .object({
      protocol: z.literal("openai-images"),
      model: z.string().min(1),
      quality: z.enum(["low", "medium", "high", "auto"]).default("medium"),
      flexibleSizes: z.boolean().default(false),
      editsEnabled: z.boolean().default(false),
      /** 与 `OPENAI_IMAGE_PRICE_TABLE` 同形状的 JSON 原文（档表）。 */
      priceTable: z.string().optional(),
    })
    .optional(),
  chat: z.object({ model: z.string().min(1) }).optional(),
  catalog: z
    .object({
      source: z.enum(["static", "models-endpoint"]).default("static"),
      models: z.record(z.string(), modelSpecSchema).default({}),
      unknownCredits: z.number().positive().optional(),
    })
    .optional(),
});

export type RelayConfig = z.infer<typeof relayConfigSchema>;

const relaysFileSchema = z.object({
  schemaVersion: z.literal(1),
  relays: z.array(relayConfigSchema),
});

export function relaysFilePath(): string {
  return path.join(dataDir(), "relays.json");
}

export function relaysFileExists(): boolean {
  return existsSync(relaysFilePath());
}

/** 配置落盘（原子写）。管理接口与本模块的 seed 都走这里。 */
export async function writeRelays(relays: RelayConfig[]): Promise<void> {
  await writeJsonAtomic(relaysFilePath(), { schemaVersion: 1, relays });
}

export function readRelaysFile(): RelayConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(relaysFilePath(), "utf8"));
  } catch (error) {
    log("error", "data/relays.json 无法解析，relay 列表按空处理", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const result = relaysFileSchema.safeParse(parsed);
  if (!result.success) {
    log("error", "data/relays.json 校验失败，relay 列表按空处理", {
      issues: result.error.issues.length,
    });
    return [];
  }
  return result.data.relays;
}

export type LoadedRelays = {
  relays: RelayConfig[];
  /** 这次配置的来源。 */
  source: "file" | "env-seed" | "legacy";
};

/**
 * 同步读取当前 relay 配置。装配在模块加载时就要答案，不能 await，所以这里用
 * 同步 fs——读的是一个小 JSON，代价可忽略。
 */
export function loadRelaysDetailed(): LoadedRelays {
  const file = relaysFilePath();
  if (existsSync(file)) return { relays: readRelaysFile(), source: "file" };

  const raw = lumenRelaysRaw();
  if (raw) {
    const seeded = parseRelaysJson(raw, "LUMEN_RELAYS");
    if (seeded) {
      try {
        mkdirSync(dataDir(), { recursive: true });
        writeFileSync(file, JSON.stringify({ schemaVersion: 1, relays: seeded }, null, 2), "utf8");
        return { relays: seeded, source: "env-seed" };
      } catch (error) {
        log("error", "LUMEN_RELAYS 种子写入 relays.json 失败，本次按 env 内容运行", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { relays: seeded, source: "env-seed" };
      }
    }
    // env 里写了但解析失败：视同没写，落回老 env 折算（并在上面 warn 过）。
  }

  return { relays: legacyEnvRelays(), source: "legacy" };
}

function parseRelaysJson(raw: string, label: string): RelayConfig[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("warn", `${label} 无法解析`, { length: raw.length });
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { relays?: unknown[] })?.relays;
  if (!Array.isArray(list)) {
    log("warn", `${label} 不是数组`, {});
    return null;
  }
  const out: RelayConfig[] = [];
  for (const entry of list) {
    const result = relayConfigSchema.safeParse(entry);
    if (result.success) out.push(result.data);
    else log("warn", `${label} 里的 relay 校验失败，已跳过`, { issues: result.error.issues.length });
  }
  return out;
}

/**
 * 老 env 折算：**无论 key 在不在**都给出 yman / openai 两条预设——
 * `providerForId("yman"|"openai")` 必须始终可解析，否则历史任务记录里的
 * provider id 会变成 unknown provider。key 有没有由 `hasKey()` 在路由时回答。
 * 折算值不写进文件，全部字段仍是调用时读 env（`presets.ts` 里是 thunk）。
 */
export function legacyEnvRelays(): RelayConfig[] {
  return [
    {
      id: "yman",
      name: "YMan",
      // baseUrl 填占位：真正的 base 由预设的 view 经 `ymanBase()` 调用时取（见 presets.ts）。
      baseUrl: "https://vip.yman.cc/v1",
      keyEnv: "YMAN_API_KEY",
      enabled: true,
      priority: 0,
      creditsPerCny: 100,
      video: {
        protocol: "openai-videos",
        defaults: {},
      },
      image: {
        protocol: "openai-images",
        model: "gpt-image-2",
        quality: "medium",
        flexibleSizes: true,
        editsEnabled: false,
      },
      catalog: { source: "static", models: {} },
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      keyEnv: "OPENAI_API_KEY",
      enabled: true,
      priority: 0,
      image: {
        protocol: "openai-images",
        model: "gpt-image-1",
        quality: "auto",
        flexibleSizes: false,
        editsEnabled: false,
      },
    },
  ];
}

/** 文件 mtime，热重载轮询用它判断要不要重读。文件不存在返回 null。 */
export function relaysFileMtime(): number | null {
  try {
    return statSync(relaysFilePath()).mtimeMs;
  } catch {
    return null;
  }
}

export type { RelayModelSpec };
