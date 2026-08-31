export const RATE_USD_PER_SEC = {
  "grok-imagine-video-1.5": 0.08,
  "grok-imagine-video": 0.05,
} as const;

export const RATE_USD_PER_IMAGE = {
  "grok-imagine-image-2.0": 0.02,
} as const;

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
