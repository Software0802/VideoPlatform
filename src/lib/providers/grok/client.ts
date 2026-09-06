import { readFile } from "node:fs/promises";
import path from "node:path";
import { grokApiKey, upstreamRetryBaseMs, upstreamTimeoutMs, xaiBase } from "@/lib/env";
import { ProviderHttpError } from "@/lib/providers/types";

export function xaiHeaders(json = true): Record<string, string> {
  const key = grokApiKey();
  if (!key) throw new Error("缺少 XAI_API_KEY 或 SUB2API_API_KEY");
  const h: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * 落盘下载的鉴权头。实现搬到了 `@/lib/media/download-headers`（下载不再只有 xAI 一个
 * 上游，YMan 的 `/videos/{id}/content` 同样要带 Bearer），这里保留同名再导出，
 * 既有的调用方与测试不用改。
 */
export { downloadHeadersFor } from "@/lib/media/download-headers";

export async function grokPost(pathSuffix: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(`${xaiBase()}${pathSuffix}`, {
    method: "POST",
    headers: xaiHeaders(true),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw upstreamError(res.status, data);
  }
  return data;
}

export async function grokGet(pathSuffix: string): Promise<Record<string, unknown>> {
  const res = await fetchUpstream(`${xaiBase()}${pathSuffix}`, { headers: xaiHeaders(false) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw upstreamError(res.status, data);
  }
  return data;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * `maxAttempts: 1` disables the transient-status retry, for upstreams that bill per accepted
 * request: a retried POST there is a second charge, not a free second chance.
 */
export type FetchUpstreamOptions = { timeoutMs?: number; maxAttempts?: number };

export async function fetchUpstream(
  url: string,
  init: RequestInit,
  opts?: FetchUpstreamOptions,
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? upstreamTimeoutMs();
  const maxAttempts = Math.max(1, Math.floor(opts?.maxAttempts ?? MAX_ATTEMPTS));
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts - 1) {
        return response;
      }
      try {
        await response.body?.cancel();
      } catch {
        // The next attempt does not depend on releasing the prior body.
      }
    } catch (error) {
      lastError = controller.signal.aborted
        ? new ProviderHttpError(504, "upstream_timeout", "上游请求超时")
        : error;
      if (attempt === maxAttempts - 1) {
        if (controller.signal.aborted) throw lastError;
        throw new ProviderHttpError(503, "upstream_unavailable", "上游暂时不可用");
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(upstreamRetryBaseMs() * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new ProviderHttpError(503, "upstream_unavailable", "上游暂时不可用");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared by every OpenAI-shaped upstream (xAI and OpenAI use the same error envelope). */
export function upstreamError(status: number, body: Record<string, unknown>): ProviderHttpError {
  const raw = body.error;
  const error = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const code =
    typeof error?.code === "string"
      ? error.code
      : typeof error?.type === "string"
        ? error.type
        : `upstream_http_${status}`;
  const message =
    typeof error?.message === "string" ? error.message : `上游 HTTP ${status}`;
  return new ProviderHttpError(status, code, message);
}

export async function uploadXaiFile(filePath: string, filename: string): Promise<string> {
  const bytes = await readFile(filePath);
  const blob = new Blob([bytes], { type: mimeFor(filename) });
  const form = new FormData();
  form.set("purpose", "assistants");
  form.set("file", blob, filename);
  const res = await fetchUpstream(`${xaiBase()}/files`, {
    method: "POST",
    headers: xaiHeaders(false),
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw upstreamError(res.status, data);
  }
  if (typeof data.id !== "string" || !data.id) {
    throw new ProviderHttpError(502, "upstream_invalid_response", "Files 上传响应缺少 id");
  }
  return data.id;
}

export async function downloadXaiFile(fileId: string, dest: string): Promise<void> {
  const res = await fetchUpstream(`${xaiBase()}/files/${fileId}/content`, {
    headers: xaiHeaders(false),
  });
  if (!res.ok || !res.body) {
    throw new ProviderHttpError(res.status, `files_download_${res.status}`, `Files 下载失败 HTTP ${res.status}`);
  }
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

export async function deleteXaiFile(fileId: string): Promise<void> {
  try {
    await fetchUpstream(`${xaiBase()}/files/${fileId}`, {
      method: "DELETE",
      headers: xaiHeaders(false),
    });
  } catch {
    /* best-effort */
  }
}

function mimeFor(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}
