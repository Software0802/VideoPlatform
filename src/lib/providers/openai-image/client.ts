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
  // Read the body as text first: a base64 image is megabytes, and swallowing a decode
  // failure into `{}` would surface later as the misleading "上游未返回图片".
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw new ProviderHttpError(
      502,
      "upstream_body_read_failed",
      `读取上游响应失败（HTTP ${res.status}）：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (!res.ok) throw upstreamError(res.status, {});
    throw new ProviderHttpError(
      502,
      "upstream_invalid_json",
      `上游响应不是 JSON（HTTP ${res.status}，${text.length} 字节）`,
    );
  }
  if (!res.ok) {
    throw upstreamError(res.status, data);
  }
  return data;
}
