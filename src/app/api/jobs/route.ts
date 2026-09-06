import { z } from "zod";
import { jsonError } from "@/lib/http";
import { createJob } from "@/lib/jobs/create";
import { listJobsPage, MAX_PAGE_LIMIT } from "@/lib/jobs/list";
import { createJobBodySchema } from "@/lib/jobs/schema";
import { toPublic } from "@/lib/jobs/store";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";
import { consumeRateLimit } from "@/lib/users/rate-limit";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 每人每分钟能提交多少次任务（方案 §3.2「安全收口」）。
 *
 * 与余额、配额、在途上限各管一件事：余额管「一共能花多少钱」，在途上限管「同时能占
 * 几个执行槽」，这一条管「按键的速度」——它挡的是脚本，而脚本正是把前两条一次性撞满
 * 的东西。键只按用户不按 IP：会话已经把请求绑到账号上了，再按 IP 分桶只会误伤同一个
 * 出口后面的几个人。
 */
const JOBS_RATE_LIMIT = 10;

/**
 * 列表查询（方案 §1.4）。`before` 是上一页返回的 `nextBefore`（ISO `createdAt`），
 * `kind` 对应主页的视频 / 图片两个页签。
 *
 * 三个参数都可以不给；给了就必须合法——一个拼错的 `kind` 静默返回全部，会让前端以为
 * 筛选生效了。空串（`?kind=`）在解析前剔掉，当作没给。
 */
const listQuerySchema = z
  .object({
    before: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), { message: "before 必须是 ISO 时间" })
      .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
    kind: z.enum(["video", "image"]).optional(),
  })
  .strict();

async function list(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const raw: Record<string, string> = {};
    for (const key of ["before", "limit", "kind"] as const) {
      const value = params.get(key);
      if (value !== null && value !== "") raw[key] = value;
    }
    const query = listQuerySchema.parse(raw);
    const page = await listJobsPage(user.id, query);
    // `nextBefore` 只在真有下一页时出现——前端拿「有没有这个字段」判断还能不能加载更多，
    // 恒定给一个值会让「加载更多」永远点不完。
    return Response.json({
      jobs: page.jobs.map(toPublic),
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    });
  } catch (e) {
    return jsonError(e);
  }
}

async function create(request: Request) {
  try {
    const user = await requireUser(request);
    const gate = consumeRateLimit([`jobs:user:${user.id}`], { limit: JOBS_RATE_LIMIT });
    if (!gate.allowed) {
      throw new ProviderHttpError(
        429,
        "rate_limited",
        `提交过于频繁，请 ${gate.retryAfterSec} 秒后再试`,
      );
    }
    const json = await request.json();
    const body = createJobBodySchema.parse(json);
    const { job, replay } = await createJob(body, user.id);
    return Response.json(job, { status: replay ? 200 : 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
export const POST = withRequestContext(create);
