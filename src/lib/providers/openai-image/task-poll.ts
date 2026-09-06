import { openaiBase, openaiImageTaskTimeoutMs } from "@/lib/env";
import {
  openaiGetBody,
  openaiGetJson,
  type OpenaiResponseBody,
} from "@/lib/providers/openai-image/client";
import { parseImageResponse, type OpenAiImageUsage } from "@/lib/providers/openai-image/rest-map";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * The async half of the images protocol.
 *
 * When an upstream cannot finish inside its own synchronous window it answers the generation
 * POST with `202 { id, status: "running", poll_after_ms }` instead of an image. From there the
 * image is fetched in three free steps and one billed one:
 *
 *   GET /images/tasks/{id}          → status, repeated every `poll_after_ms` (free)
 *   GET /images/tasks/{id}/result   → the bytes; **this** is what settles the charge
 *
 * Nothing in here ever re-sends the generation POST: that would create a *second* task and pay
 * for a second image. A GET, by contrast, is safe to repeat, so the generic transport retry
 * stays enabled for the polls.
 */

/** Upstream default when the payload does not say. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Floor: honour a rude `poll_after_ms: 1` without hammering the upstream. */
export const MIN_POLL_INTERVAL_MS = 1_000;
/** Ceiling: a bogus `poll_after_ms: 3600000` must not swallow the whole task budget in one nap. */
export const MAX_POLL_INTERVAL_MS = 30_000;

const TASKS_PATH = "/images/tasks";

/** Statuses meaning "the image exists, go fetch it". */
const SUCCEEDED_STATES = new Set([
  "succeeded",
  "success",
  "successful",
  "completed",
  "complete",
  "finished",
  "done",
  "ok",
]);

/** Statuses meaning "keep polling". Anything else non-empty is treated as a failure. */
const PENDING_STATES = new Set([
  "running",
  "queued",
  "pending",
  "processing",
  "in_progress",
  "in-progress",
  "waiting",
  "created",
  "accepted",
  "starting",
  "submitted",
]);

export type TaskState = "succeeded" | "failed" | "pending";

export type PendingImageTask = {
  id: string;
  /** Already clamped into [MIN, MAX]. */
  pollAfterMs: number;
  /** The 202 body, reused as the first status snapshot so a ready task needs no extra GET. */
  snapshot: Record<string, unknown>;
};

export type ImageTaskOutcome = {
  bytes: Buffer;
  usage?: OpenAiImageUsage;
  /**
   * `actual_charge` off the final status, when the upstream reports one. Its unit follows the
   * upstream (`pricing_currency` is CNY on ccgoai) exactly like `OPENAI_IMAGE_PRICE_TABLE` —
   * no FX conversion happens anywhere in this codebase.
   */
  actualCharge?: number;
};

export type ImageTaskDeps = {
  fetchStatus?: (taskId: string) => Promise<Record<string, unknown>>;
  fetchResult?: (url: string) => Promise<OpenaiResponseBody>;
  base?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Asked between polls and, crucially, immediately before the result fetch.
   * Without it a cancellation during a ten-minute poll would still end in the
   * one call that costs money. Omitted (the default) means "never abort", which
   * is exactly the previous behaviour.
   */
  shouldAbort?: () => Promise<boolean>;
};

/**
 * Is this generation response a task handle rather than an image?
 *
 * A 202 always is — and one without an `id` is unpollable, so it fails loudly instead of being
 * reported as "上游未返回图片". A 200 that carries a running handle and no `data` array is
 * accepted too (some relays answer 200 for the same envelope), but an actual image always wins.
 */
export function readPendingTask(
  status: number,
  data: Record<string, unknown>,
): PendingImageTask | null {
  const id = str(data.id);
  if (status === 202) {
    if (!id) {
      throw new ProviderHttpError(
        502,
        "upstream_invalid_response",
        "上游返回 202 受理但没有任务 id，无法轮询结果",
      );
    }
    return handle(id, data);
  }
  if (!id) return null;
  if (Array.isArray(data.data) && data.data.length > 0) return null;
  // Outside a 202 the handle must say so *explicitly*: a malformed 200 keeps failing as
  // "上游未返回图片" rather than being polled as a task that was never created.
  return PENDING_STATES.has(str(data.status).toLowerCase()) ? handle(id, data) : null;
}

function handle(id: string, data: Record<string, unknown>): PendingImageTask {
  return { id, pollAfterMs: clampPollDelayMs(data.poll_after_ms), snapshot: data };
}

/** `status` first; a missing status only counts as done when `result_available` says so. */
export function taskState(data: Record<string, unknown>): TaskState {
  const raw = str(data.status).toLowerCase();
  if (SUCCEEDED_STATES.has(raw)) return "succeeded";
  if (PENDING_STATES.has(raw)) return "pending";
  // An unknown non-empty status (failed / canceled / expired / whatever this relay invents) is
  // terminal: polling it forever would only burn the task budget before failing anyway.
  if (raw) return "failed";
  return data.result_available === true ? "succeeded" : "pending";
}

export function clampPollDelayMs(raw: unknown, fallback = DEFAULT_POLL_INTERVAL_MS): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  const wanted = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(wanted)));
}

export function taskStatusPath(taskId: string): string {
  return `${TASKS_PATH}/${encodeURIComponent(taskId)}`;
}

/**
 * Absolute URL of the result endpoint.
 *
 * The upstream hands out `result_url` as an absolute *path* that already carries the API prefix
 * (`/v1/images/tasks/…/result`). Concatenating it onto a base that ends in `/v1` would produce
 * `/v1/v1/…`, so the path is resolved against the base's **origin** and the base path is only
 * prepended when the upstream left it out.
 */
export function resolveTaskResultUrl(base: string, taskId: string, resultUrl?: unknown): string {
  const fallback = `${base}${taskStatusPath(taskId)}/result`;
  const raw = str(resultUrl);
  if (!raw) return fallback;
  if (/^https?:\/\//i.test(raw)) return raw;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return fallback;
  }
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const rel = raw.startsWith("/") ? raw : `/${raw}`;
  const needsPrefix = Boolean(basePath) && rel !== basePath && !rel.startsWith(`${basePath}/`);
  return `${baseUrl.origin}${needsPrefix ? `${basePath}${rel}` : rel}`;
}

/** Poll the task to a terminal state, then fetch and return its bytes. */
export async function awaitImageTask(
  task: PendingImageTask,
  deps: ImageTaskDeps = {},
): Promise<ImageTaskOutcome> {
  const fetchStatus = deps.fetchStatus ?? ((id: string) => openaiGetJson(taskStatusPath(id)));
  const fetchResult = deps.fetchResult ?? openaiGetBody;
  const base = deps.base ?? openaiBase();
  const timeoutMs = deps.timeoutMs ?? openaiImageTaskTimeoutMs();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const shouldAbort = deps.shouldAbort;

  const abortIfCanceled = async (): Promise<void> => {
    if (shouldAbort && (await shouldAbort())) throw taskCanceled(task.id);
  };

  const started = now();
  let snapshot = task.snapshot;
  let delayMs = task.pollAfterMs;

  for (;;) {
    const state = taskState(snapshot);
    if (state === "succeeded") {
      // The last gate before the only billed GET in this file. A job canceled while we
      // were napping must not have its image fetched — `charge_status:"pending_delivery"`
      // means the upstream settles on delivery, so taking it would make cancelling *cost*
      // money.
      await abortIfCanceled();
      return deliver(task.id, snapshot, base, fetchResult);
    }
    if (state === "failed") throw taskFailed(task.id, snapshot);
    // Never sleep past the deadline: waiting out a nap we already know is too long would only
    // delay the same failure. The task keeps running upstream either way.
    if (now() - started + delayMs > timeoutMs) throw taskTimedOut(task.id, timeoutMs);
    await sleep(delayMs);
    // Woken up: the job may have been canceled during the nap, so stop before even the
    // free status GET rather than looping on a job nobody wants any more.
    await abortIfCanceled();
    snapshot = await fetchStatus(task.id);
    delayMs = clampPollDelayMs(snapshot.poll_after_ms, delayMs);
  }
}

async function deliver(
  taskId: string,
  snapshot: Record<string, unknown>,
  base: string,
  fetchResult: (url: string) => Promise<OpenaiResponseBody>,
): Promise<ImageTaskOutcome> {
  const body = await fetchResult(resolveTaskResultUrl(base, taskId, snapshot.result_url));
  const actualCharge = readActualCharge(snapshot);
  if (body.kind === "binary") return { bytes: body.bytes, actualCharge };
  // A relay that answers the result endpoint with the ordinary `{ data: [{ b64_json }] }`
  // envelope is still serving the same image; decode it the same way.
  const { png, usage } = parseImageResponse(body.data);
  return { bytes: png, usage, actualCharge };
}

/** Only a positive, finite charge is trusted; `0` means "not settled yet", not "free". */
function readActualCharge(snapshot: Record<string, unknown>): number | undefined {
  const raw = snapshot.actual_charge;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function taskFailed(taskId: string, snapshot: Record<string, unknown>): ProviderHttpError {
  const error =
    snapshot.error && typeof snapshot.error === "object"
      ? (snapshot.error as Record<string, unknown>)
      : undefined;
  const status = str(snapshot.status) || "failed";
  const code = str(error?.code) || str(error?.type) || `image_task_${status}`;
  const message =
    str(error?.message) ||
    str(snapshot.error) ||
    str(snapshot.message) ||
    str(snapshot.failure_reason) ||
    "上游未说明原因";
  return new ProviderHttpError(502, code, `上游出图任务失败（${status}）：${message}`);
}

/**
 * Abandoning a task the caller no longer wants. 499 is deliberately outside the
 * runner's retryable range, and the runner's `fail` is a no-op on an
 * already-canceled record, so this ends the job as `canceled` rather than
 * `failed`. The task keeps running upstream; nobody fetches its result, which is
 * what keeps it unbilled.
 */
function taskCanceled(taskId: string): ProviderHttpError {
  return new ProviderHttpError(
    499,
    "canceled",
    `任务已取消，未取回上游出图结果（任务 ${taskId}）`,
  );
}

function taskTimedOut(taskId: string, timeoutMs: number): ProviderHttpError {
  return new ProviderHttpError(
    504,
    "image_task_timeout",
    `上游出图任务 ${timeoutMs / 1000} 秒内未完成。任务 ${taskId} 仍在上游运行，可用 ` +
      `GET ${TASKS_PATH}/${taskId} 查状态、GET ${TASKS_PATH}/${taskId}/result 取图` +
      `（取回结果才计费）；等更久请调大 OPENAI_IMAGE_TASK_TIMEOUT_MS。`,
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
