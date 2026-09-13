import { createHmac } from "node:crypto";

import {
  alertWebhookFormat,
  alertWebhookSecret,
  alertWebhookTimeoutMs,
  alertWebhookUrl,
  type AlertWebhookFormat,
} from "@/lib/env";
import { log } from "@/lib/log";

/**
 * 「该有人看一眼」的事件外发（方案 §3.2「可观测性」）。
 *
 * 这些事件本来就各自打了一条 warn，但日志只有人主动去翻才看得见，而它们恰好是
 * **越晚发现越贵**的那一类：预算穿了还在重试、上游积分耗尽全站任务改道、磁盘快满
 * 到写不下成片。配了 `ALERT_WEBHOOK_URL` 就把同一条事实 POST 出去一份。
 *
 * 三条纪律：
 * - **绝不影响主流程**：外发失败只记一条 warn。告警是尽力而为的旁路，不是判据。
 * - **不带密钥、不带提示词**：payload 只有 id、金额、供应商名这类运维字段。
 * - **有超时**：webhook 挂住时不能把 runner 的任务槽或一次 health 请求拖死。
 */
export type AlertEvent =
  | "budget_exceeded"
  | "cost_over_target"
  | "provider_exhausted"
  | "disk_low"
  /** 上游返回 404 查不到配置的模型——本地默认 / 配置还指着它，需要人工换名或下架。 */
  | "upstream_model_missing"
  /** relay × 通道连续失败触发的 5 分钟冷却（方案 §4c 健康分级）。 */
  | "relay_unhealthy"
  /** `POST /api/admin/alerts/test` 的上线验证通道。 */
  | "test";

export type AlertPayload = Record<string, string | number | boolean | null | undefined>;

/**
 * 同一件事在短时间内只发一次。
 *
 * 触发点大多在循环里（每个 shot 都可能超预算、每条任务都会撞到同一家耗尽的上游、
 * 每次 health 探测都会看到同一块满磁盘），不去重的话一次故障能打出几百条通知，
 * 结果就是没人再看它。键由调用方给（事件 + 主体），窗口 10 分钟。
 */
const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_KEYS = 500;

type AlertState = { sentAt: Map<string, number> };
const globalAlertState = globalThis as typeof globalThis & { __lumenAlerts?: AlertState };

function sentAt(): Map<string, number> {
  const state = (globalAlertState.__lumenAlerts ??= { sentAt: new Map() });
  return state.sentAt;
}

/** 测试与运维用：清掉去重窗口，让下一次同样的事件重新发出。 */
export function resetAlertDedupe(): void {
  sentAt().clear();
}

function shouldSend(key: string, nowMs: number): boolean {
  const map = sentAt();
  const previous = map.get(key);
  if (previous !== undefined && nowMs - previous < DEDUPE_WINDOW_MS) return false;
  if (map.size > MAX_TRACKED_KEYS) {
    for (const [k, at] of map) if (nowMs - at >= DEDUPE_WINDOW_MS) map.delete(k);
    if (map.size > MAX_TRACKED_KEYS) map.clear();
  }
  map.set(key, nowMs);
  return true;
}

/** 机器人渠道统一走「首行 [Lumen] 事件名」的文本消息；钉钉自定义关键词因此填 `Lumen`。 */
function alertText(event: AlertEvent, at: Date, payload: AlertPayload): string {
  let text = `[Lumen] ${event}\n${at.toISOString()}`;
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    text += `\n${key}: ${String(value)}`;
  }
  return text;
}

function hmacSha256Base64(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64");
}

/**
 * 按渠道拼出一次 POST 的 `{ url, body }`（纯函数，方便测试固定签名值）。
 *
 * - `generic`：旧行为，平铺 `{ event, at, ...payload }`，URL 原样。
 * - `feishu`：text 消息体；配了 secret 时加 `timestamp`（秒）与 `sign`，签名算法
 *   `base64(HmacSHA256(key = `${timestamp}\n${secret}`, message = ""))`——官方文档：
 *   https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN
 * - `dingtalk`：text 消息体；配了 secret 时 URL 追加 `timestamp`（毫秒）与
 *   `sign`，签名算法 `urlencode(base64(HmacSHA256(key = secret,
 *   message = `${timestamp}\n${secret}`)))`——官方文档：
 *   https://open.dingtalk.com/document/orgapp/customize-robot-security-settings
 * - `wecom`：text 消息体，无签名。
 */
export function buildAlertRequest(
  format: AlertWebhookFormat,
  url: string,
  secret: string | undefined,
  event: AlertEvent,
  at: Date,
  payload: AlertPayload,
): { url: string; body: string } {
  if (format === "generic") {
    return { url, body: JSON.stringify({ event, at: at.toISOString(), ...payload }) };
  }

  const text = alertText(event, at, payload);

  if (format === "feishu") {
    const body: Record<string, unknown> = {
      msg_type: "text",
      content: { text },
    };
    if (secret) {
      const timestamp = String(Math.floor(at.getTime() / 1000));
      body.timestamp = timestamp;
      body.sign = hmacSha256Base64(`${timestamp}\n${secret}`, "");
    }
    return { url, body: JSON.stringify(body) };
  }

  if (format === "dingtalk") {
    let requestUrl = url;
    if (secret) {
      const timestamp = String(at.getTime());
      const sign = hmacSha256Base64(secret, `${timestamp}\n${secret}`);
      const parsed = new URL(url);
      parsed.searchParams.set("timestamp", timestamp);
      parsed.searchParams.set("sign", sign);
      requestUrl = parsed.toString();
    }
    return {
      url: requestUrl,
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    };
  }

  // wecom：与钉钉 text 消息形状相同，但没有加签机制。
  return {
    url,
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  };
}

/**
 * 发一条告警。**永不抛错、永不 reject**，调用方可以直接 `void notifyAlert(...)`。
 * 返回是否真正发出并被对端 2xx 收下（未配置 URL / 被去重 / 非 2xx / 网络异常 → false）。
 *
 * `dedupeKey` 默认是事件名本身；同一事件要按主体分别去重（比如按 provider、按 jobId）
 * 时由调用方拼出来。
 */
export async function notifyAlert(
  event: AlertEvent,
  payload: AlertPayload = {},
  dedupeKey?: string,
): Promise<boolean> {
  const url = alertWebhookUrl();
  if (!url) return false;
  if (!shouldSend(dedupeKey ?? event, Date.now())) return false;

  const format = alertWebhookFormat();
  const request = buildAlertRequest(
    format,
    url,
    alertWebhookSecret(),
    event,
    new Date(),
    payload,
  );
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
      signal: AbortSignal.timeout(alertWebhookTimeoutMs()),
    });
    if (!response.ok) {
      log("warn", "告警 webhook 返回非 2xx", { event, format, status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    log("warn", "告警 webhook 发送失败", {
      event,
      format,
      msg: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
