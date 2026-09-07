import { z } from "zod";
import { jsonError } from "@/lib/http";
import { createJob } from "@/lib/jobs/create";
import { listJobsPage, MAX_PAGE_LIMIT } from "@/lib/jobs/list";
import { consumeJobCreation } from "@/lib/jobs/rate-limit";
import { createJobBodySchema } from "@/lib/jobs/schema";
import { toPublic } from "@/lib/jobs/store";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

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
    // 桶的定义在 `@/lib/jobs/rate-limit`：智能体那条路径（`run-turn.ts`）绕过 HTTP 直接
    // 调 `createJob`，必须消费**同一个**桶，否则它就是这条限流的绕过路径。
    const gate = consumeJobCreation(user.id);
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
