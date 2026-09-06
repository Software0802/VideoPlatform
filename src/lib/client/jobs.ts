import type { JobPublic } from "@/lib/jobs/schema";
import { ApiError, parseAuthed, redirectToLogin } from "@/lib/client/http";

/**
 * Browser-side wrappers over /api/*. A 401 now means the session expired, so
 * `parseAuthed` sends the browser to `/login` (plan §7) instead of raising a
 * modal — there is no per-instance access token any more.
 */

export { ApiError };

export type UploadResult = { uploadId: string; durationSec: number | null };

export async function uploadFile(file: File, role: string): Promise<UploadResult> {
  const fd = new FormData();
  fd.set("role", role);
  fd.set("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body: fd });
  const data = await parseAuthed<{ uploadId: string; durationSec?: number }>(res, "上传失败");
  return { uploadId: data.uploadId, durationSec: typeof data.durationSec === "number" ? data.durationSec : null };
}

/**
 * 把自己一条已完成任务的产物认领成一次上传（阶段 A 契约 `POST /api/uploads/from-job`）。
 *
 * 素材弹窗的「已创建」页签走这条：首帧 / 尾帧 / 参考图要的都是 `uploadId`，而已生成的
 * 图片只有一个 `/api/media/...` 地址。让服务端在自己这边复制一份并出 sidecar，比让
 * 浏览器把图片下载回来再传一遍省一个来回，也不用把成片字节暴露给别的路径。
 */
export async function uploadFromJob(jobId: string, role: string): Promise<UploadResult> {
  const res = await fetch("/api/uploads/from-job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, role }),
  });
  const data = await parseAuthed<{ uploadId: string; durationSec?: number }>(res, "选取素材失败");
  return { uploadId: data.uploadId, durationSec: typeof data.durationSec === "number" ? data.durationSec : null };
}

export async function createJob(body: Record<string, unknown>): Promise<JobPublic> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseAuthed<JobPublic>(res, "创建失败");
}

export async function fetchJob(id: string): Promise<JobPublic | null> {
  const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError("会话已过期，请重新登录", 401, "unauthorized");
  }
  if (!res.ok) return null;
  return (await res.json()) as JobPublic;
}

export async function cancelJob(id: string): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
  return parseAuthed<JobPublic>(res, "取消失败");
}

export async function retryJob(id: string): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
  return parseAuthed<JobPublic>(res, "重试失败");
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
