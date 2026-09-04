import type { JobPublic } from "@/lib/jobs/schema";

/** Browser-side wrappers over /api/*. 401 is surfaced via the callback so the shell can show the token prompt. */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function parse<T>(res: Response, fallback: string, onUnauthorized?: () => void): Promise<T> {
  if (res.status === 401) onUnauthorized?.();
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok) throw new ApiError(data?.error?.message ?? fallback, res.status);
  return data as T;
}

export type UploadResult = { uploadId: string; durationSec: number | null };

export async function uploadFile(file: File, role: string, onUnauthorized?: () => void): Promise<UploadResult> {
  const fd = new FormData();
  fd.set("role", role);
  fd.set("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body: fd });
  const data = await parse<{ uploadId: string; durationSec?: number }>(res, "上传失败", onUnauthorized);
  return { uploadId: data.uploadId, durationSec: typeof data.durationSec === "number" ? data.durationSec : null };
}

export async function createJob(body: Record<string, unknown>, onUnauthorized?: () => void): Promise<JobPublic> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parse<JobPublic>(res, "创建失败", onUnauthorized);
}

export async function fetchJob(id: string): Promise<JobPublic | null> {
  const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
  if (res.status === 401) throw new ApiError("需要访问令牌", 401);
  if (!res.ok) return null;
  return (await res.json()) as JobPublic;
}

export async function cancelJob(id: string, onUnauthorized?: () => void): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
  return parse<JobPublic>(res, "取消失败", onUnauthorized);
}

export async function retryJob(id: string, onUnauthorized?: () => void): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
  return parse<JobPublic>(res, "重试失败", onUnauthorized);
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
