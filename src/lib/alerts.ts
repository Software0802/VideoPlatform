import { alertWebhookTimeoutMs, alertWebhookUrl } from "@/lib/env";
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
  | "upstream_model_missing";

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

/**
 * 发一条告警。**永不抛错、永不 reject**，调用方可以直接 `void notifyAlert(...)`。
 *
 * `dedupeKey` 默认是事件名本身；同一事件要按主体分别去重（比如按 provider、按 jobId）
 * 时由调用方拼出来。
 */
export async function notifyAlert(
  event: AlertEvent,
  payload: AlertPayload = {},
  dedupeKey?: string,
): Promise<void> {
  const url = alertWebhookUrl();
  if (!url) return;
  if (!shouldSend(dedupeKey ?? event, Date.now())) return;

  const body = JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...payload,
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(alertWebhookTimeoutMs()),
    });
    if (!response.ok) {
      log("warn", "告警 webhook 返回非 2xx", { event, status: response.status });
    }
  } catch (error) {
    log("warn", "告警 webhook 发送失败", {
      event,
      msg: error instanceof Error ? error.message : String(error),
    });
  }
}
