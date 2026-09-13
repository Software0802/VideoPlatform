import { notifyAlert } from "@/lib/alerts";
import { fetchUpstream } from "@/lib/providers/grok/client";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * OpenAI `/videos` 兼容中转的 HTTP 客户端——从 `providers/yman/client.ts` 提炼。
 * 传输层（超时、abort、瞬时状态重试）复用 xAI 客户端里打磨过的 `fetchUpstream`，
 * 这里只管 base URL、Bearer 鉴权与错误信封。
 */

/** 一次上游调用需要的最小身份：谁、去哪、用哪把 key。 */
export type RelayEndpoint = {
  /** 告警与日志里的 provider 名（= provider id）。 */
  id: string;
  name: string;
  keyEnvName: string;
  apiKey(): string | undefined;
  base(): string;
};

/** key 不进返回值、不进日志、不进错误消息。 */
export function relayHeaders(rt: RelayEndpoint, json = true): Record<string, string> {
  const key = rt.apiKey();
  if (!key) {
    throw new ProviderHttpError(500, "missing_api_key", `缺少 ${rt.keyEnvName}`);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * 创建任务。**固定 `maxAttempts: 1`**：上游一受理就预扣积分，超时或 5xx 后重发 POST
 * 不是「第二次机会」，而是第二条任务、第二笔钱。失败由用户决定要不要重新提交。
 */
export async function relayPost(
  rt: RelayEndpoint,
  pathSuffix: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(
    `${rt.base()}${pathSuffix}`,
    {
      method: "POST",
      headers: relayHeaders(rt, true),
      body: JSON.stringify(body),
    },
    { maxAttempts: 1 },
  );
  try {
    return await readRelayBody(rt, res);
  } catch (err) {
    // 创建任务的 404 = 上游查不到这个模型名（下架 / 改名），错误照抛、另发去重告警；
    // GET 轮询的 404 是任务句柄丢失，不在这里告警。
    if (err instanceof ProviderHttpError && err.status === 404) {
      const model =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).model
          : undefined;
      const name = typeof model === "string" && model ? model : "unknown";
      void notifyAlert(
        "upstream_model_missing",
        { provider: rt.id, model: name, base: rt.base() },
        `${rt.id}:${name}`,
      );
    }
    throw err;
  }
}

/** 查询任务。免费、无副作用，所以保留通用的瞬时状态重试。 */
export async function relayGet(
  rt: RelayEndpoint,
  pathSuffix: string,
): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(`${rt.base()}${pathSuffix}`, {
    method: "GET",
    headers: relayHeaders(rt, false),
  });
  return readRelayBody(rt, res);
}

async function readRelayBody(rt: RelayEndpoint, res: Response): Promise<Record<string, unknown>> {
  const parsed = (await res.json().catch(() => ({}))) as unknown;
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (!res.ok) throw relayError(rt, res.status, data);
  return data;
}

/**
 * HTTP 状态 → 本项目的错误信封。映射出来的 code 直接决定 runner 的行为：
 * `rate_limited` / `quota_exhausted` 走退避重排（`UPSTREAM_BACKOFF_CODES`），
 * `service_unavailable` / `internal_error` 进轮询的可重试集合，其余是终态失败。
 *
 * 402 的中文兜底是「平台积分不足」而不是「你的余额不足」——扣的是我们在中转站的积分，
 * 用户那边什么也没做错。
 */
export function relayError(
  rt: RelayEndpoint,
  status: number,
  body: Record<string, unknown>,
): ProviderHttpError {
  const raw = body.error;
  const error = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
  const upstreamMessage =
    typeof error?.message === "string" && error.message ? error.message : undefined;
  const upstreamCode =
    typeof error?.code === "string" && error.code
      ? error.code
      : typeof error?.type === "string" && error.type
        ? error.type
        : undefined;

  const mapped = MAPPED_STATUS[status];
  if (mapped) {
    const message = upstreamMessage ?? mapped.message.replace("{}", rt.name);
    return new ProviderHttpError(status, mapped.code, message);
  }
  // 5xx 原样透传（runner 的可重试集合按 status >= 500 也能认出来）。
  return new ProviderHttpError(
    status,
    upstreamCode ?? `upstream_http_${status}`,
    upstreamMessage ?? `${rt.name} 上游 HTTP ${status}`,
  );
}

const MAPPED_STATUS: Record<number, { code: string; message: string }> = {
  // 参数不在定价表 / 请求体不合法。
  400: { code: "invalid_argument", message: "请求参数不被上游接受" },
  401: { code: "unauthorized", message: "{} API Key 无效" },
  402: { code: "quota_exhausted", message: "平台积分不足，请联系管理员" },
  404: { code: "not_found", message: "上游查不到该模型或任务" },
  // content 还没就绪。poll 侧当 pending 处理，不是失败。
  409: { code: "not_ready", message: "成片尚未就绪" },
  // 参考图 / 参考视频过大。
  413: { code: "invalid_argument", message: "参考素材过大，请压缩后重试" },
  429: { code: "rate_limited", message: "上游并发已满，请稍后再试" },
  451: { code: "moderation", message: "未通过内容安全审核" },
  501: { code: "unsupported", message: "上游不支持该参数组合" },
};
