import { klingApiKey, klingBase } from "@/lib/env";
// 传输层（超时、abort、瞬时状态重试）与 provider 无关，xAI 客户端里已经打磨过，
// 这里只换 base URL、鉴权头与错误信封。
import { fetchUpstream } from "@/lib/providers/grok/client";
import { ProviderHttpError } from "@/lib/providers/types";

/** key 不进返回值、不进日志、不进错误消息。 */
export function klingHeaders(json = true): Record<string, string> {
  const key = klingApiKey();
  if (!key) {
    throw new ProviderHttpError(500, "missing_api_key", "缺少 KLING_API_KEY");
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * 创建任务。**固定 `maxAttempts: 1`**：任务一旦被受理就占并发并计费，
 * 超时或 5xx 后重发 POST 不是「第二次机会」，而是第二条任务、第二笔钱。
 * 超时用通用的 `UPSTREAM_TIMEOUT_MS`——这是一次即时受理的请求，出片是后面轮询的事。
 */
export async function klingPost(
  pathSuffix: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(
    `${klingBase()}${pathSuffix}`,
    {
      method: "POST",
      headers: klingHeaders(true),
      body: JSON.stringify(body),
    },
    { maxAttempts: 1 },
  );
  return readKlingBody(res);
}

/** 查询任务。免费、无副作用、不占并发，所以保留通用的瞬时状态重试。 */
export async function klingGet(pathSuffix: string): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(`${klingBase()}${pathSuffix}`, {
    method: "GET",
    headers: klingHeaders(false),
  });
  return readKlingBody(res);
}

async function readKlingBody(res: Response): Promise<Record<string, unknown>> {
  const parsed = (await res.json().catch(() => ({}))) as unknown;
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const code = typeof data.code === "number" ? data.code : undefined;
  // 业务失败与传输失败都在这里收口：可灵在 HTTP 非 2xx 时也带同一个信封，
  // 而 `code !== 0` 即便 HTTP 200 也是失败。
  if (!res.ok || (code != null && code !== 0)) {
    throw klingError(res.status, data);
  }
  return data;
}

/**
 * 可灵错误码 → 本项目的错误信封。映射出来的 code 直接决定 runner 的行为：
 * `moderation` 走「未通过安全审核」，`service_unavailable` / `internal_error` /
 * `upstream_timeout` 与 429 一起落进 runner 的可重试集合。
 */
const KLING_CODE_MAP: Record<number, { status: number; code: string }> = {
  1101: { status: 429, code: "quota_exhausted" },
  1102: { status: 429, code: "quota_exhausted" },
  1301: { status: 400, code: "moderation" },
  1302: { status: 429, code: "rate_limited" },
  1303: { status: 429, code: "rate_limited" },
  5000: { status: 500, code: "internal_error" },
  5001: { status: 503, code: "service_unavailable" },
  5002: { status: 504, code: "upstream_timeout" },
};

export function klingError(status: number, body: Record<string, unknown>): ProviderHttpError {
  const code = typeof body.code === "number" ? body.code : undefined;
  const message =
    typeof body.message === "string" && body.message ? body.message : `可灵上游 HTTP ${status}`;
  const mapped = code != null ? KLING_CODE_MAP[code] : undefined;
  if (mapped) return new ProviderHttpError(mapped.status, mapped.code, message);
  if (code == null) return new ProviderHttpError(status, `upstream_http_${status}`, message);
  // HTTP 2xx 但 code !== 0：传输没问题，错在业务参数，按 400 记。
  const httpStatus = status >= 200 && status < 300 ? 400 : status;
  return new ProviderHttpError(httpStatus, `kling_${code}`, message);
}
