export const RATE_USD_PER_SEC = {
  "grok-imagine-video-1.5": 0.08,
  "grok-imagine-video": 0.05,
} as const;

export const RATE_USD_PER_IMAGE = {
  "grok-imagine-image-2.0": 0.02,
  /**
   * Submit-time estimate only. gpt-image-1's real charge depends on quality and size
   * ($0.011 – $0.25, see OPENAI_IMAGE_LIST_PRICE_USD) and `estimateCostUsd(model, duration)`
   * cannot see either, so the cheapest tier is booked as a lower bound and the provider
   * overwrites it with the usage-based figure once the image comes back.
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

/**
 * What one gpt-image-1 call cost. `outputTokens` from the response is authoritative; the table
 * is the fallback, and an unknown size falls back to the priciest tier of its quality so a call
 * is never booked cheaper than it can actually be.
 */
export function estimateOpenaiImageCostUsd(opts: {
  size: string;
  quality: string;
  outputTokens?: number;
}): number {
  const tokens = opts.outputTokens;
  if (tokens != null && Number.isFinite(tokens) && tokens > 0) {
    // Cent rounding would erase a $0.011 image; keep micro-dollars like the LLM ledger.
    return Math.round(((tokens * OPENAI_IMAGE_RATE_USD_PER_MTOKEN_OUTPUT) / 1_000_000) * 1e6) / 1e6;
  }
  const listed = OPENAI_IMAGE_LIST_PRICE_USD[`${opts.quality}:${opts.size}`];
  if (listed != null) return listed;
  return opts.quality === "low" ? 0.016 : 0.25;
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

export function estimateCostUsd(model: string, durationSec: number): number {
  if (model in RATE_USD_PER_IMAGE) {
    return RATE_USD_PER_IMAGE[model as keyof typeof RATE_USD_PER_IMAGE];
  }
  const rate =
    model in RATE_USD_PER_SEC
      ? RATE_USD_PER_SEC[model as keyof typeof RATE_USD_PER_SEC]
      : RATE_USD_PER_SEC["grok-imagine-video-1.5"];
  return roundUsd(rate * durationSec);
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
