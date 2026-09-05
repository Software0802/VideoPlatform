/**
 * Token usage of a chat.completions call (Director / visual QC). Lumen has no
 * verified price table for grok-4.6 text+vision, so these calls are booked as
 * usage, never as USD — the job's `costIncomplete` flag tells the UI so (R05).
 */
export type LlmUsage = { promptTokens: number; completionTokens: number };

export type LlmCompletion = { content: string; usage?: LlmUsage };

export function normalizeCompletion(result: string | LlmCompletion): LlmCompletion {
  return typeof result === "string" ? { content: result } : result;
}

export function usageFromResponse(
  usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined,
): LlmUsage | undefined {
  if (!usage) return undefined;
  return { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 };
}
