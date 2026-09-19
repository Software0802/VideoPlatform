import { z } from "zod";
import { jsonError } from "@/lib/http";
import { retryJob } from "@/lib/jobs/create";
import { readJobForUser } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 可选请求体：`acceptPriceCny` 是用户在界面上确认过的那个价。
 * 重试按当下参数重新定价，比原来贵时服务端先抛 409 `retry_price_changed`，
 * 带上这个字段的第二次请求才放行（review 2026-09-15 B-10）。
 */
const retryBodySchema = z.object({ acceptPriceCny: z.number().nonnegative().optional() }).strict();

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const rec = await readJobForUser(id, user.id);
    if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    // 没有请求体是常态（第一次点击）：读不出 JSON 就按空对象走。
    const raw = await request.json().catch(() => ({}));
    const body = retryBodySchema.parse(raw ?? {});
    const job = await retryJob(rec, user.id, body);
    return Response.json(job, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
