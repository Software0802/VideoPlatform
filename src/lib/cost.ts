import {
  klingUsdPerUnit,
  openaiImagePriceTableRaw,
  usdCnyRate,
  ymanImagePriceTableRaw,
} from "@/lib/env";
import { log } from "@/lib/log";
import { creditsFor, isYmanModel, type YmanResolution } from "@/lib/providers/yman/catalog";
import type { ProviderId } from "@/lib/providers/types";

export const RATE_USD_PER_SEC = {
  "grok-imagine-video-1.5": 0.08,
  "grok-imagine-video": 0.05,
} as const;

/**
 * 可灵按「积分 / 秒」计价，键是 `${model}:${resolution}:${audio}`——同一个模型的单价
 * 由分辨率与是否出声决定，模型名单独看不出来。有声只有 1080p 一档（上游硬约束）。
 * 未经真实账单核实的列表价占位（2026-09-06 官方定价页），实付以 poll 回来的 billing 为准。
 */
export const KLING_UNITS_PER_SEC: Record<string, number> = {
  "kling-2.6:720p:off": 0.3,
  "kling-2.6:1080p:off": 0.5,
  "kling-2.6:1080p:native": 1.0,
  "kling-2.5-turbo:720p:off": 0.3,
  "kling-2.5-turbo:1080p:off": 0.5,
};

/** 积分 → USD。单价低到 $0.03/秒，分单位取整会把一条 5 秒片记成 0，所以留微分。 */
export function klingUnitsToUsd(units: number): number {
  const n = Number.isFinite(units) ? units : 0;
  return roundMicro(n * klingUsdPerUnit());
}

/**
 * YMan 积分 → USD：¥1 = 100 积分，再按 `USD_CNY_RATE` 折美元。与可灵的积分不是一回事
 * （那边是充值比例，这边是人民币面值），所以各有各的换算函数。同样留微分。
 */
export function ymanCreditsToUsd(credits: number): number {
  const n = Number.isFinite(credits) ? credits : 0;
  return roundMicro(n / 100 / usdCnyRate());
}

/** `VideoPricingHint.resolution` 是自由字符串；YMan 只有两档，认不出按 720p 记。 */
function ymanResolution(resolution: string | undefined): YmanResolution {
  return resolution === "1080p" ? "1080p" : "720p";
}

/**
 * 提交时的可灵单价。表里没有这个组合（换了模型、或上游加了新档）就取该模型最贵的一档，
 * 整个模型都不认识时取全表最贵的一档——宁可高估，也不把一次调用记得比它可能的花费便宜。
 */
function klingUnitsPerSec(model: string, video?: VideoPricingHint): number {
  const direct = video ? KLING_UNITS_PER_SEC[`${model}:${video.resolution}:${video.audio}`] : undefined;
  if (direct != null) return direct;
  const sameModel = Object.entries(KLING_UNITS_PER_SEC)
    .filter(([key]) => key.startsWith(`${model}:`))
    .map(([, rate]) => rate);
  return Math.max(...(sameModel.length ? sameModel : Object.values(KLING_UNITS_PER_SEC)));
}

export const RATE_USD_PER_IMAGE = {
  "grok-imagine-image-2.0": 0.02,
  /**
   * Submit-time lower bound only. gpt-image-1's real charge depends on quality and size
   * ($0.011 – $0.25, see OPENAI_IMAGE_LIST_PRICE_USD); the cheapest tier is booked here and
   * the provider overwrites it with the usage-based figure once the image comes back.
   * 只在既没有档表、`estimateCostUsd` 又拿不到更准的 size/quality 时才落到这一条。
   * 未经真实账单核实的列表价占位。
   */
  "gpt-image-1": 0.011,
} as const;

/** OpenAI bills image output tokens at $40 / M (gpt-image-1). 未经真实账单核实的列表价占位。 */
export const OPENAI_IMAGE_RATE_USD_PER_MTOKEN_OUTPUT = 40;

/**
 * List prices derived from that $40/M rate, keyed `quality:size`.
 * 未经真实账单核实的列表价占位（与 LLM_RATE_USD_PER_MTOKEN 同等信心）——只在响应缺 usage 时用。
 */
export const OPENAI_IMAGE_LIST_PRICE_USD: Record<string, number> = {
  "low:1024x1024": 0.011,
  "low:1536x1024": 0.016,
  "low:1024x1536": 0.016,
  "high:1024x1024": 0.167,
  "high:1536x1024": 0.25,
  "high:1024x1536": 0.25,
};

export const IMAGE_SIZE_TIERS = ["1K", "2K", "4K"] as const;
export type ImageSizeTier = (typeof IMAGE_SIZE_TIERS)[number];
/** quality → 尺寸档 → 单价。价目是上游特定的，只来自 `OPENAI_IMAGE_PRICE_TABLE`。 */
export type ImagePriceTable = Record<string, Partial<Record<ImageSizeTier, number>>>;

/**
 * 提交时无法定价的图片模型的保守占位（既不是 0——那会让配额完全看不见这次调用——
 * 也不当成真实账单）。真实金额在 provider 返回后由 `estimateOpenaiImageCostUsd` 覆盖。
 * 未经真实账单核实的占位。
 */
export const UNKNOWN_IMAGE_ESTIMATE_USD = 0.02;

/**
 * 按最长边归档：≤1024 → 1K，≤2048 → 2K，更大 → 4K。中转站按「质量档 × 尺寸档 × 张数」
 * 计费，不按 token。`auto` 由上游选尺寸，本地看不见，按 2K 记（1K 与 2K 常同价，且不低估）。
 * 无法解析的尺寸同样按 2K 记，宁可高估也不把一次调用记成最便宜的一档。
 */
export function imageSizeTier(size: string): ImageSizeTier {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size ?? "").trim());
  if (!m) return "2K";
  const longest = Math.max(Number(m[1]), Number(m[2]));
  if (!Number.isFinite(longest) || longest <= 0) return "2K";
  if (longest <= 1024) return "1K";
  if (longest <= 2048) return "2K";
  return "4K";
}

/**
 * `OPENAI_IMAGE_PRICE_TABLE` 的解析结果，未设置或坏掉时为 null（调用方回落到 token 口径）。
 *
 * ⚠️ 单位随上游而定：中转站（如 ccgoai）扣的是**人民币额度**，不是美元。表一旦配置，
 * `costUsdEstimate` / `costUsdActual` 里的数字就是「上游额度」而非 USD——做配额时别当美元读。
 */
export function openaiImagePriceTable(): ImagePriceTable | null {
  return imagePriceTable(openaiImagePriceTableRaw(), "OPENAI_IMAGE_PRICE_TABLE");
}

/** 同款语义的 YMan 生图价目表（单位是人民币额度，见上面的告警）。 */
export function ymanImagePriceTable(): ImagePriceTable | null {
  return imagePriceTable(ymanImagePriceTableRaw(), "YMAN_IMAGE_PRICE_TABLE");
}

/** 每张表各自缓存一份：两条生图通道的原文互不相干，共用一个槽会互相踢掉。 */
const priceTableCaches = new Map<string, { raw: string; table: ImagePriceTable | null }>();

function imagePriceTable(raw: string | undefined, envName: string): ImagePriceTable | null {
  if (!raw) return null;
  const cached = priceTableCaches.get(envName);
  if (cached?.raw === raw) return cached.table;
  const table = parsePriceTable(raw);
  if (!table) {
    // 一张坏 JSON 不能打挂生图：记一条并回落到 token 口径。
    log("warn", `${envName} 无法解析，图片计价回落到 token 口径`, { length: raw.length });
  }
  priceTableCaches.set(envName, { raw, table });
  return table;
}

function parsePriceTable(raw: string): ImagePriceTable | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: ImagePriceTable = {};
  let usable = false;
  for (const [quality, tiers] of Object.entries(parsed as Record<string, unknown>)) {
    if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) continue;
    const row: Partial<Record<ImageSizeTier, number>> = {};
    for (const tier of IMAGE_SIZE_TIERS) {
      const value = (tiers as Record<string, unknown>)[tier];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        row[tier] = value;
        usable = true;
      }
    }
    if (Object.keys(row).length) out[quality.trim().toLowerCase()] = row;
  }
  return usable ? out : null;
}

/**
 * 档表命中价。缺这一档（画质名对不上，或这一档没配）时取同尺寸档里最贵的一条，
 * 免得把一次调用记得比它可能的花费更便宜；整张表都没有这一档才返回 null。
 */
function priceFromTable(table: ImagePriceTable, quality: string, tier: ImageSizeTier): number | null {
  const direct = table[String(quality ?? "").trim().toLowerCase()]?.[tier];
  if (direct != null) return direct;
  const candidates = Object.values(table)
    .map((row) => row[tier])
    .filter((n): n is number => typeof n === "number");
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * What one image call cost.
 *
 * 配置了 `OPENAI_IMAGE_PRICE_TABLE`（中转站按档计费）时档表说了算，token 精算不参与——
 * 中转站根本不按 token 计费，`usage` 只是它转发的形状。未配置时保持官方口径：
 * `outputTokens` 优先，其次列表价表，未知尺寸落到该画质最贵的一档。
 */
export function estimateOpenaiImageCostUsd(
  opts: {
    size: string;
    quality: string;
    outputTokens?: number;
  },
  /** 这条通道自己的价目表（第二条兼容通道用 YMan 的那张）；不传就是官方那张。 */
  table: ImagePriceTable | null = openaiImagePriceTable(),
): number {
  if (table) {
    const tiered = priceFromTable(table, opts.quality, imageSizeTier(opts.size));
    if (tiered != null) return roundMicro(tiered);
  }
  const tokens = opts.outputTokens;
  if (tokens != null && Number.isFinite(tokens) && tokens > 0) {
    // Cent rounding would erase a $0.011 image; keep micro-dollars like the LLM ledger.
    return roundMicro((tokens * OPENAI_IMAGE_RATE_USD_PER_MTOKEN_OUTPUT) / 1_000_000);
  }
  const listed = OPENAI_IMAGE_LIST_PRICE_USD[`${opts.quality}:${opts.size}`];
  if (listed != null) return listed;
  return opts.quality === "low" ? 0.016 : 0.25;
}

function roundMicro(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * LLM list prices in USD per million tokens, for the Director and visual-QC
 * chat completions. xAI's public list price for the grok-4 family is $3 / $15
 * per million input / output tokens.
 * 列表价占位，待 ticks 对账核实（与 UNVERIFIED_RESOLUTION_RATES 同等信心）。
 */
export const LLM_RATE_USD_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  "grok-4.6": { input: 3, output: 15 },
};

const DEFAULT_LLM_MODEL = "grok-4.6";

/**
 * Conservative reservation for one paid LLM call, taken before the call so a
 * parallel run cannot spend the same headroom twice; the real charge replaces it
 * once usage comes back.
 *
 * `director`: system prompt + the plan JSON schema + brief ≈ 8k input tokens and a
 *   full Bible + shot list ≈ 4k output tokens ≈ $0.084 per attempt, and
 *   `createDirectorPlan` may burn up to 3 schema-retry attempts under one
 *   reservation → $0.30.
 * `visualQc`: Bible brief + up to 6 inline images ≈ 9k input tokens and a 5-field
 *   score ≈ 300 output tokens ≈ $0.032 → $0.05 per shot attempt.
 */
export const LLM_RESERVE_USD: { director: number; visualQc: number } = {
  director: 0.3,
  visualQc: 0.05,
};

/** List-price estimate of one chat completion; unknown models fall back to grok-4.6. */
export function estimateLlmCostUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const rate = LLM_RATE_USD_PER_MTOKEN[model] ?? LLM_RATE_USD_PER_MTOKEN[DEFAULT_LLM_MODEL];
  if (!rate) return 0;
  const prompt = Math.max(0, Number.isFinite(usage.promptTokens) ? usage.promptTokens : 0);
  const completion = Math.max(0, Number.isFinite(usage.completionTokens) ? usage.completionTokens : 0);
  // Cent rounding would erase a $0.004 call; the LLM ledger keeps micro-dollars.
  return Math.round(((prompt * rate.input + completion * rate.output) / 1_000_000) * 1e6) / 1e6;
}

const TICKS_PER_USD = 10_000_000_000;

/**
 * 提交时已知的图片请求形状。模型名单独看不出单价（`gpt-image-2` 之类的中转模型根本不在
 * 任何本地表里），把即将发出的 size / quality 一起带上，估算才不会退化成 0。
 */
export type ImagePricingHint = {
  size: string;
  quality: string;
  /**
   * 这次生图会走哪条兼容通道。两条通道各有各的价目表（`OPENAI_IMAGE_PRICE_TABLE` /
   * `YMAN_IMAGE_PRICE_TABLE`），光看模型名分不出来——两边都可能叫 `gpt-image-2`。
   */
  provider?: ProviderId;
};

/**
 * 提交时已知的视频请求形状。可灵的单价随分辨率与音频档变化，YMan 的随分辨率与时长档
 * 变化，模型名单独都看不出来；xAI 视频不看它（按模型名的每秒单价计）。
 *
 * `provider` 让路由已经选定的那家说了算：YMan 允许用户自己填模型名，那种名字不在
 * 本地目录里，光看名字会掉进按秒的 xAI 分支被估成一个毫不相干的数。
 */
export type VideoPricingHint = {
  resolution: string;
  audio: "off" | "native";
  provider?: ProviderId;
};

/**
 * 没有 hint 时的兜底判据：一个不在 `RATE_USD_PER_IMAGE` 里的图片模型（`gpt-image-2` 之类的
 * 中转模型）否则会掉进按秒的视频分支，被 durationSec=0 记成 0。
 * 视频模型名不含 "image"（`grok-imagine-*` 是 imagine，不匹配）。
 */
const IMAGE_MODEL_RE = /image/i;

/** 可灵模型名一律 `kling-` 打头（`kling-2.6`、`kling-2.5-turbo`），且不含 "image"。 */
const KLING_MODEL_RE = /^kling-/i;

export function estimateCostUsd(
  model: string,
  durationSec: number,
  image?: ImagePricingHint,
  video?: VideoPricingHint,
): number {
  if (image || model in RATE_USD_PER_IMAGE || IMAGE_MODEL_RE.test(model)) {
    return estimateImageSubmitCostUsd(model, image);
  }
  // YMan 按「分辨率价 + 时长价」的积分计价，与时长不成正比（10 秒与 15 秒常同价），
  // 所以既不能按秒也不能按模型单价；目录认得的模型、或路由已经点名 yman 时都走这条。
  if (video?.provider === "yman" || isYmanModel(model)) {
    return ymanCreditsToUsd(creditsFor(model, durationSec, ymanResolution(video?.resolution)));
  }
  // 可灵按积分计价，且同模型的单价由 resolution × audio 决定，与 xAI 的按模型单价不是一套。
  if (KLING_MODEL_RE.test(model)) {
    return klingUnitsToUsd(klingUnitsPerSec(model, video) * durationSec);
  }
  const rate =
    model in RATE_USD_PER_SEC
      ? RATE_USD_PER_SEC[model as keyof typeof RATE_USD_PER_SEC]
      : RATE_USD_PER_SEC["grok-imagine-video-1.5"];
  return roundUsd(rate * durationSec);
}

/**
 * 提交时的图片成本下限，按可得信息逐级回落：
 * 档表（若配置）→ 该模型的本地单价 → 官方列表价 → 明确标注的保守占位。
 * 绝不返回 0：`costUsdEstimate === 0` 会让配额与账目完全看不见这次调用。
 */
function estimateImageSubmitCostUsd(model: string, image?: ImagePricingHint): number {
  if (image) {
    const table = image.provider === "yman" ? ymanImagePriceTable() : openaiImagePriceTable();
    const tiered = table ? priceFromTable(table, image.quality, imageSizeTier(image.size)) : null;
    if (tiered != null) return roundMicro(tiered);
  }
  const known = RATE_USD_PER_IMAGE[model as keyof typeof RATE_USD_PER_IMAGE];
  if (known != null) return known;
  if (image) {
    const listed = OPENAI_IMAGE_LIST_PRICE_USD[`${image.quality}:${image.size}`];
    if (listed != null) return listed;
  }
  return UNKNOWN_IMAGE_ESTIMATE_USD;
}

export type HarnessClip = Readonly<{
  kind: "generate" | "extend";
  durationSec: number;
}>;

export const HARNESS_QC_RETRY_MULTIPLIER = 1.5;

export function estimateHarnessCostUsd(clips: readonly HarnessClip[]): number {
  if (!clips.length) throw new Error("非法 Harness clip");
  let total = 0;
  for (const clip of clips) {
    if (
      (clip.kind !== "generate" && clip.kind !== "extend") ||
      !Number.isInteger(clip.durationSec) ||
      clip.durationSec < 1 ||
      clip.durationSec > 15 ||
      (clip.kind === "extend" && (clip.durationSec < 2 || clip.durationSec > 10))
    ) {
      throw new Error("非法 Harness clip");
    }
    const rate = clip.kind === "extend" ? RATE_USD_PER_SEC["grok-imagine-video"] : RATE_USD_PER_SEC["grok-imagine-video-1.5"];
    total += rate * clip.durationSec;
  }
  return roundUsd(total);
}

export function estimateHarnessRetryBudgetUsd(clips: readonly HarnessClip[]): number {
  return roundUsd(estimateHarnessCostUsd(clips) * HARNESS_QC_RETRY_MULTIPLIER);
}

export function ticksToUsd(ticks: number): number {
  return roundUsd(ticks / TICKS_PER_USD);
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

// Historical third-party resolution multipliers. NOT used in UI.
// Unverified against 2026-08-28 model cards.
export const UNVERIFIED_RESOLUTION_RATES = {
  "grok-imagine-video-1.5": { "480p": 0.08, "720p": 0.14, "1080p": 0.25 },
  "grok-imagine-video": { "480p": 0.05, "720p": 0.07, "1080p": 0.07 },
} as const;
