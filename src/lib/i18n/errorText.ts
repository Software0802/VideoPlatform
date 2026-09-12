import { ApiError } from "@/lib/client/http";
import type { MessageParams } from "@/lib/i18n/format";
import { hasMessage, type MessageKey } from "@/lib/i18n/messages";

/** `useT()` 返回的翻译函数（结构签名，与 `Translate` 一致）。 */
export type ErrorTranslate = (key: MessageKey, params?: MessageParams) => string;

/**
 * 细节在服务端 `message` 里的码：字典文案后面用中文冒号拼上原文。
 * 英文界面下后半段仍是中文——那是服务端细节，不装作翻译了（方案 §3）。
 */
const DETAIL_CODES = new Set(["invalid_argument", "invalid_state", "conflict"]);

/**
 * 把一次 API 失败翻成给用户看的当前语言文案。
 *
 * - `ApiError` 且 `common.err.<code>` 在 zh-CN 字典里 → 字典文案；
 *   `DETAIL_CODES` 里的码再拼上服务端 `message`；
 * - `ApiError` 但字典没有该码（上游透传 / 漏测的新码）→ `common.err.unknown`，
 *   带上 `x-request-id`（proxy 每次响应都会回写），不再直接显示服务端原文；
 * - 非 `ApiError`（断网、解析错）→ `common.err.unknown`，没有 requestId 就不带括号。
 */
export function errorText(t: ErrorTranslate, error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const key = `common.err.${error.code}`;
    if (hasMessage(key)) {
      const text = t(key);
      if (DETAIL_CODES.has(error.code) && error.message) return `${text}：${error.message}`;
      return text;
    }
  }
  const requestId =
    error instanceof ApiError && error.requestId
      ? t("common.err.requestId", { requestId: error.requestId })
      : "";
  return t("common.err.unknown", { requestId });
}
