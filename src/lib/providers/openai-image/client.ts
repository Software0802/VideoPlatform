import { openaiApiKey, openaiBase, openaiImageTimeoutMs } from "@/lib/env";
// The transport (timeout, abort, transient-status retry) is provider-agnostic and already
// hardened for the xAI client; only the base URL and headers differ here.
import { fetchUpstream, upstreamError } from "@/lib/providers/grok/client";
import { ProviderHttpError } from "@/lib/providers/types";

/** The key never appears in a return value, a log line or an error message. */
export function openaiHeaders(): Record<string, string> {
  const key = openaiApiKey();
  if (!key) {
    throw new ProviderHttpError(500, "missing_api_key", "缺少 OPENAI_API_KEY");
  }
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export async function openaiPost(
  pathSuffix: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(
    `${openaiBase()}${pathSuffix}`,
    {
      method: "POST",
      headers: openaiHeaders(),
      body: JSON.stringify(body),
    },
    // One attempt only, on a timeout long enough for gpt-image-1: every accepted request is
    // billed, so a retry after a timeout or a 5xx pays twice for one image. Let it fail and
    // let the user decide whether to resubmit.
    { timeoutMs: openaiImageTimeoutMs(), maxAttempts: 1 },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw upstreamError(res.status, data);
  }
  return data;
}
