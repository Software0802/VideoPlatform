import type { JobRecord } from "@/lib/jobs/schema";
import { listJobIndex, type JobIndexEntry } from "@/lib/jobs/index";
import { readJobsByIds } from "@/lib/jobs/store";

/**
 * 「读一个人的作品列表」的唯一入口（方案 `docs/plan-frontend-backend-adaptation.md` §1.4）。
 *
 * 收口成一个函数，是为了让后面换实现时只动这里：现在是「读全量再切片」（
 * `listJobRecordsForUser` 逐个读 `job.json`），任务索引落地后换成读索引，路由与它的
 * 契约都不用动。分页与筛选的语义（严格早于游标、按 `createdAt` 倒序、`kind` 归类）
 * 也因此只有一份定义。
 */

export type JobKind = "video" | "image";

export const DEFAULT_PAGE_LIMIT = 24;
export const MAX_PAGE_LIMIT = 50;

export type ListJobsOptions = {
  /** 游标：只要**严格早于**这个 `createdAt` 的任务。ISO，通常是上一页的 `nextBefore`。 */
  before?: string;
  /** 本页条数，1–50，默认 24。 */
  limit?: number;
  kind?: JobKind;
};

export type JobsPage = {
  jobs: JobRecord[];
  /** 还有下一页时给出的游标；没有它就是到底了。 */
  nextBefore?: string;
};

/**
 * 作品属于视频还是图片。
 *
 * 有成片就按成片的实际类型分——`output.kind` 是磁盘上真实存在的那个文件；还没出片
 * （排队 / 进行中 / 失败）时只能按 mode 归类，否则用户刚提交的那条图片任务会在视频
 * 页签里晃一下再跳走。
 */
export function jobKind(rec: Pick<JobRecord, "mode" | "output">): JobKind {
  if (rec.output?.kind === "image") return "image";
  if (rec.output?.kind === "video") return "video";
  return rec.mode === "text_to_image" ? "image" : "video";
}

export function clampPageLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.floor(raw), 1), MAX_PAGE_LIMIT);
}

/** 索引条目的归类：有成片按成片类型，没有按 mode（与 `jobKind` 同一口径）。 */
function indexKind(entry: JobIndexEntry): JobKind {
  if (entry.outputKind) return entry.outputKind;
  return entry.mode === "text_to_image" ? "image" : "video";
}


/**
 * 一页作品，按 `createdAt` 倒序。只列本人的（`listJobRecordsForUser` 已经按
 * `canAccessJob` 过滤，非本人的任务在这里根本不存在，而不是被筛掉）。
 *
 * 游标是「严格早于」，所以同一毫秒创建的两条任务会有一条被跨过去——`count` 1–4 那种
 * 连续创建是真的能撞上同一毫秒的。这里的处理是**不切开同一时刻的那一组**：切到第
 * `limit` 条后，把与它 `createdAt` 相同的后续记录一并放进本页，让页边界永远落在两个
 * 不同的时刻之间。代价是一页可能多返回几条，换来的是「严格早于」不会丢记录。
 */
export async function listJobsPage(
  ownerId: string,
  opts: ListJobsOptions = {},
): Promise<JobsPage> {
  const limit = clampPageLimit(opts.limit);
  // 非法游标在路由层已被拒（400）；这里再判一次 finite，是为了让直接调用它的
  // 服务端渲染路径不至于把整张列表按 NaN 全筛掉。
  const beforeMs = opts.before ? Date.parse(opts.before) : NaN;
  const hasCursor = Number.isFinite(beforeMs);

  // 走任务索引（`data/jobs/index.json`，已按 createdAt 倒序），只对本页的 id 回读 job.json；
  // 可见性口径与旧的 `listJobRecordsForUser` 一致（`forUser` 含管理员可见的无主任务）。
  const entries = await listJobIndex({ forUser: ownerId });
  const filtered = entries.filter((entry) => {
    if (opts.kind && indexKind(entry) !== opts.kind) return false;
    if (!hasCursor) return true;
    // `createdAt` 坏掉的记录（手改过的 job.json）定位不了，翻页时跳过；首页仍然看得见。
    const ms = Date.parse(entry.createdAt);
    return Number.isFinite(ms) && ms < beforeMs;
  });

  if (filtered.length <= limit) return { jobs: await readJobsByIds(filtered.map((e) => e.id)) };

  let end = limit;
  const boundary = Date.parse(filtered[end - 1].createdAt);
  if (Number.isFinite(boundary)) {
    while (end < filtered.length && Date.parse(filtered[end].createdAt) === boundary) end += 1;
  }
  const jobs = await readJobsByIds(filtered.slice(0, end).map((e) => e.id));
  if (end >= filtered.length || !Number.isFinite(boundary)) return { jobs };
  // 归一成 ISO 毫秒：游标必须能被下一次请求原样解析回同一个时刻。
  return { jobs, nextBefore: new Date(boundary).toISOString() };
}
