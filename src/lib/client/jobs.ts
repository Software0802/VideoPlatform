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

/* ── 阶段 B：作品列表分页 / 标签 / 删除 / 分享 ── */

export type JobKind = "video" | "image";

export type JobsPage = { jobs: JobPublic[]; nextBefore?: string };

/**
 * `GET /api/jobs?before=&limit=&kind=`（阶段 B 契约）。
 *
 * 返回体**两种形状都收**：阶段 B 之前这个路由回的是裸数组，之后是
 * `{ jobs, nextBefore? }`。前后端并行落地时前端不能因为后端还没换而白屏，所以这里
 * 按 `auth.ts` 的 `readBalance` 同一个口径做结构化读取：认得的形状取出来，认不得的
 * 当作空页（调用方会当作「没有更多」停下，而不是无限重试）。
 */
export async function fetchJobsPage(
  opts: { before?: string; limit?: number; kind?: JobKind } = {},
): Promise<JobsPage> {
  const q = new URLSearchParams();
  if (opts.before) q.set("before", opts.before);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.kind) q.set("kind", opts.kind);
  const suffix = q.size ? `?${q.toString()}` : "";
  const res = await fetch(`/api/jobs${suffix}`, { cache: "no-store" });
  const data = await parseAuthed<unknown>(res, "无法读取作品列表");
  if (Array.isArray(data)) return { jobs: data as JobPublic[] };
  if (data && typeof data === "object") {
    const body = data as { jobs?: unknown; nextBefore?: unknown };
    return {
      jobs: Array.isArray(body.jobs) ? (body.jobs as JobPublic[]) : [],
      nextBefore: typeof body.nextBefore === "string" && body.nextBefore ? body.nextBefore : undefined,
    };
  }
  return { jobs: [] };
}

/*
  标签的三个常量是 `@/lib/jobs/tags` 的**镜像**（那份是事实源，含 zod 校验）。这里重抄
  一遍而不是 import，理由与 `models.ts` 的产品类型相同：客户端包不去依赖服务端模块，
  也不为几个常量把 zod 拖进浏览器。两边改的时候要一起改；不一致的后果只是「界面先拦
  一下」和「服务端 400」的措辞差异，不会让请求变得不安全。
*/

/** 主页分类芯片 / 详情浮层预置标签，顺序即芯片顺序。 */
export const PRESET_TAGS = [
  "广告",
  "电影叙事",
  "风格艺术",
  "动物剧场",
  "特效",
  "数字人",
  "动漫游戏",
  "情绪特写",
  "音乐",
] as const;

/** 一条作品最多几个标签。 */
export const MAX_TAGS = 5;
/** 单个标签的长度上限，按**字**（码点）算——与服务端 `tagLength` 同一个口径。 */
export const MAX_TAG_LEN = 16;

/** 码点数。`"😀".length` 是 2，但服务端算 1 字；用 `String.length` 会比服务端更严。 */
export function tagLength(tag: string): number {
  return [...tag].length;
}

/**
 * `JobPublic.tags`。后端与前端并行落地，老记录也没有这个字段，所以用结构化读取而不是
 * 直接取字段——与 `models.ts` 的 `productNameOf` 同一个理由：两边落地顺序不该决定前端
 * 能不能编译，更不该渲染出 `undefined`。
 */
export function tagsOf(job: unknown): string[] {
  if (!job || typeof job !== "object") return [];
  const raw = (job as { tags?: unknown }).tags;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out.slice(0, MAX_TAGS);
}

/** `PATCH /api/jobs/:id { tags }`：整组替换，不是增量。 */
export async function patchJobTags(id: string, tags: string[]): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  return parseAuthed<JobPublic>(res, "保存标签失败");
}

/** `DELETE /api/jobs/:id` → 204（进行中的任务服务端 409 `job_active`）。 */
export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  if (res.status === 204) return;
  // 204 之外一律走通用信封解析：401 会跳登录页，409 会带出「任务进行中」那句话
  await parseAuthed<unknown>(res, "删除失败");
}

export type ShareLink = { url: string; expiresAt: string };

/** `POST /api/jobs/:id/share` → `{ url: "/s/<token>", expiresAt }`（仅成功且未清理的作品）。 */
export async function shareJob(id: string): Promise<ShareLink> {
  const res = await fetch(`/api/jobs/${id}/share`, { method: "POST" });
  const data = await parseAuthed<{ url?: unknown; expiresAt?: unknown }>(res, "生成分享链接失败");
  const url = typeof data.url === "string" ? data.url : "";
  if (!url) throw new ApiError("服务端没有返回分享链接", 502);
  return { url, expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : "" };
}

export async function cancelJob(id: string): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
  return parseAuthed<JobPublic>(res, "取消失败");
}

export async function retryJob(id: string): Promise<JobPublic> {
  const res = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
  return parseAuthed<JobPublic>(res, "重试失败");
}

/* ── 恢复中心（A 包）：`POST /api/jobs/:id/recovery/*` ── */

export type ReconcileResult = { job: JobPublic; outcome: "resumed" | "not_found" };

/**
 * 向上游核验一条 `uncertain_submit` 的任务：`resumed` = 上游认领了单子、任务接管成
 * 进行中；`not_found` = 上游确认没收到，重试随之解锁。查询失败抛 409。
 */
export async function reconcileJob(id: string): Promise<ReconcileResult> {
  const res = await fetch(`/api/jobs/${id}/recovery/reconcile`, { method: "POST" });
  return parseAuthed<ReconcileResult>(res, "核验失败");
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
