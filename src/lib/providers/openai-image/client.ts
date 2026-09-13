// The transport (timeout, abort, transient-status retry) is provider-agnostic and already
// hardened for the xAI client; only the base URL and headers differ here.
import { fetchUpstream, upstreamError } from "@/lib/providers/grok/client";
import { notifyAlert } from "@/lib/alerts";
import {
  OPENAI_IMAGE_CONFIG,
  type OpenaiImageConfig,
} from "@/lib/providers/openai-image/config";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * The key never appears in a return value, a log line or an error message.
 *
 * `cfg` defaults to the OpenAI channel, so every existing call site keeps reading
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` exactly as before; the YMan channel passes its own.
 */
export function openaiHeaders(json = true, cfg: OpenaiImageConfig = OPENAI_IMAGE_CONFIG): Record<string, string> {
  const key = cfg.apiKey();
  if (!key) {
    throw new ProviderHttpError(500, "missing_api_key", `缺少 ${cfg.keyEnvName}`);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * One upstream answer, already split by wire shape.
 *
 * `POST /images/generations` has three documented outcomes and only the *transport* can tell
 * them apart: 200 + JSON (`b64_json`), 200 + raw image bytes (some relays answer that way), and
 * 202 + JSON (the image is not ready; a task handle came back instead). `status` is carried
 * through so the caller can recognise the 202 without re-reading the response.
 */
export type OpenaiResponseBody =
  | { kind: "json"; status: number; data: Record<string, unknown> }
  | { kind: "binary"; status: number; bytes: Buffer; mime: string };

/** `image/png`, `image/jpeg; charset=…` → true. Anything else (JSON, text, empty) → false. */
export function isImageMime(contentType: string | null | undefined): boolean {
  return /^image\/[a-z0-9.+-]+$/i.test(mimeOf(contentType));
}

function mimeOf(contentType: string | null | undefined): string {
  return String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

export async function openaiPost(
  pathSuffix: string,
  body: unknown,
  cfg: OpenaiImageConfig = OPENAI_IMAGE_CONFIG,
): Promise<OpenaiResponseBody> {
  const res = await fetchUpstream(
    `${cfg.base()}${pathSuffix}`,
    {
      method: "POST",
      headers: openaiHeaders(true, cfg),
      body: JSON.stringify(body),
    },
    // One attempt only, on a timeout long enough for gpt-image-1: every accepted request is
    // billed, so a retry after a timeout or a 5xx pays twice for one image. Let it fail and
    // let the user decide whether to resubmit. (A 202 handle is *not* a retry case either —
    // it is polled, never resubmitted.)
    { timeoutMs: cfg.timeoutMs(), maxAttempts: 1 },
  );
  try {
    return await readUpstreamBody(res);
  } catch (err) {
    alertModelMissing(err, cfg, modelOfBody(body));
    throw err;
  }
}

/**
 * `POST /images/edits` — multipart variant of `openaiPost`. The content type (and its
 * boundary) is set by fetch itself; sending `application/json` here would corrupt the form.
 * Same billing rule as generations: one attempt, never re-sent.
 */
export async function openaiPostForm(
  pathSuffix: string,
  form: FormData,
  cfg: OpenaiImageConfig = OPENAI_IMAGE_CONFIG,
): Promise<OpenaiResponseBody> {
  const res = await fetchUpstream(
    `${cfg.base()}${pathSuffix}`,
    {
      method: "POST",
      headers: openaiHeaders(false, cfg),
      body: form,
    },
    { timeoutMs: cfg.timeoutMs(), maxAttempts: 1 },
  );
  try {
    return await readUpstreamBody(res);
  } catch (err) {
    const field = form.get("model");
    alertModelMissing(err, cfg, typeof field === "string" && field ? field : undefined);
    throw err;
  }
}

/**
 * Task-status GET. Free and side-effect-free upstream (only fetching the *result* settles the
 * charge), so the generic transient-status retry stays on — unlike the billed POST above.
 */
export async function openaiGetJson(
  pathSuffix: string,
  cfg: OpenaiImageConfig = OPENAI_IMAGE_CONFIG,
): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(`${cfg.base()}${pathSuffix}`, {
    method: "GET",
    headers: openaiHeaders(false, cfg),
  });
  const body = await readUpstreamBody(res);
  if (body.kind !== "json") {
    throw new ProviderHttpError(
      502,
      "upstream_invalid_response",
      `任务状态接口返回了 ${body.mime}，不是 JSON`,
    );
  }
  return body.data;
}

/**
 * Result GET on an absolute URL (the task result is bytes, and the upstream hands out an
 * absolute-path `result_url` that must not be pasted onto the `/v1` base a second time — see
 * `resolveTaskResultUrl`). Kept on the long image timeout: the body is megabytes.
 */
export async function openaiGetBody(
  url: string,
  cfg: OpenaiImageConfig = OPENAI_IMAGE_CONFIG,
): Promise<OpenaiResponseBody> {
  const res = await fetchUpstream(
    url,
    { method: "GET", headers: openaiHeaders(false, cfg) },
    { timeoutMs: cfg.timeoutMs() },
  );
  return readUpstreamBody(res);
}

/**
 * Split one response into JSON or bytes, and turn any non-2xx into a `ProviderHttpError`.
 *
 * Content-Type decides first, and only for a 2xx: an error page served as `image/*` is not an
 * image, and an error envelope is always JSON. Reading a megabyte-sized base64 body as text
 * before parsing keeps a decode failure from being swallowed into `{}` and resurfacing later
 * as the misleading "上游未返回图片".
 */
async function readUpstreamBody(res: Response): Promise<OpenaiResponseBody> {
  const contentType = res.headers.get("content-type");
  if (res.ok && isImageMime(contentType)) {
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (cause) {
      throw bodyReadFailed(res.status, cause);
    }
    const bytes = Buffer.from(buf);
    if (bytes.length === 0) {
      throw new ProviderHttpError(502, "upstream_invalid_response", "上游返回了空的图片响应体");
    }
    return { kind: "binary", status: res.status, bytes, mime: mimeOf(contentType) };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw bodyReadFailed(res.status, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!res.ok) throw normalizeImageUpstreamError(res.status, {});
    throw new ProviderHttpError(
      502,
      "upstream_invalid_json",
      `上游响应不是 JSON（HTTP ${res.status}，${text.length} 字节）`,
    );
  }
  // `null` and arrays are valid JSON but not an envelope; downstream reads fields off an object.
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (!res.ok) {
    throw normalizeImageUpstreamError(res.status, data);
  }
  return { kind: "json", status: res.status, data };
}

/**
 * 「这条通道没钱了」在兼容 OpenAI 的中转上有好几种写法，归一成同一个 `quota_exhausted`。
 *
 * 归一是耗尽自动切换的入口条件：runner 只认 `quota_exhausted` 这一个码去 `markExhausted`
 * 并改走下一家（`switchAwayFromExhausted`）。不归一的话，402 会被当成一个普通的 4xx 直接
 * 判失败，429 会被当成「上游忙」白等 15/30/60 秒再撞同一堵没钱的墙。
 *
 * 判据：
 *  - HTTP 402 一律算——这个状态码在支付语义里就是「余额 / 额度不足」，没有别的用法。
 *  - HTTP 429 只在错误码指向额度时算（`insufficient_quota` / `insufficient_credits`，以及
 *    任何含 quota / credit 的写法，大小写不敏感）；不带这类码的 429 是真的限流，该退避。
 *
 * 状态码统一记 429 而不是保留 402：402 在本项目里是「用户余额不足」的对外语义
 * （`insufficient_balance`），上游没钱与用户没钱不是一回事，不能共用一个状态码。
 */
const QUOTA_CODE = /quota|credit/i;

export function normalizeImageUpstreamError(
  status: number,
  data: Record<string, unknown>,
): ProviderHttpError {
  const error = upstreamError(status, data);
  if (status === 402 || (status === 429 && QUOTA_CODE.test(error.code))) {
    return new ProviderHttpError(429, "quota_exhausted", error.message);
  }
  // 5xx + 合法 OpenAI 错误信封（error.message 是字符串且 code/type 有其一）= 上游明确
  // 拒单、没受理也没计费——与「请求可能已送达」的断连 / 裸 5xx 是两回事，打上
  // `upstreamRejected` 让 runner 按普通失败处理而不是锁进 `uncertain_submit`。
  if (status >= 500 && isStructuredErrorEnvelope(data)) {
    return new ProviderHttpError(status, error.code, error.message, { upstreamRejected: true });
  }
  return error;
}

/** `{"error":{"message": string, "code"|"type": string}}` 的最低合法形状。 */
function isStructuredErrorEnvelope(data: Record<string, unknown>): boolean {
  const raw = data.error;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const err = raw as Record<string, unknown>;
  return (
    typeof err.message === "string" &&
    (typeof err.code === "string" || typeof err.type === "string")
  );
}

/** 请求体 / 表单里带的 model 名；读不到就用通道默认值。 */
function modelOfBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const model = (body as Record<string, unknown>).model;
  return typeof model === "string" && model ? model : undefined;
}

/**
 * 404 = 上游「查不到该模型」：任务照常失败，同时给运维发一条去重告警——模型在中转
 * 上架 / 下架时本地配置不会自己更新。GET 路径（轮询 / 取 result）的 404 是任务句柄
 * 丢失，不是模型问题，只在创建 POST 上告警。
 */
function alertModelMissing(
  err: unknown,
  cfg: OpenaiImageConfig,
  model: string | undefined,
): void {
  if (!(err instanceof ProviderHttpError) || err.status !== 404) return;
  const name = model ?? cfg.model();
  void notifyAlert(
    "upstream_model_missing",
    { provider: cfg.id, model: name, base: cfg.base() },
    `${cfg.id}:${name}`,
  );
}

function bodyReadFailed(status: number, cause: unknown): ProviderHttpError {
  return new ProviderHttpError(
    502,
    "upstream_body_read_failed",
    `读取上游响应失败（HTTP ${status}）：${cause instanceof Error ? cause.message : String(cause)}`,
  );
}
