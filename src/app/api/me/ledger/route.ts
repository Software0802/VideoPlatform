import { z } from "zod";
import { LEDGER_KINDS, LEDGER_PAGE_MAX, readLedger } from "@/lib/billing/ledger";
import { jsonError } from "@/lib/http";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

const querySchema = z.object({
  /** 游标：上一页返回的 `nextBefore`，原样传回来。 */
  before: z
    .string()
    .max(40)
    .refine((value) => !Number.isNaN(Date.parse(value)), "before 必须是 ISO 时间")
    .optional(),
  limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX).optional(),
  kind: z.enum(LEDGER_KINDS).optional(),
});

/**
 * 自己的积分流水（方案 §1.7「积分使用详情 / 账单记录」）。倒序分页，
 * `kind=grant` 就是账单记录，`kind=charge` 就是消费明细。
 *
 * 只读自己的：`userId` 来自会话，请求里没有任何选择用户的入口。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const query = querySchema.parse({
      before: params.get("before") ?? undefined,
      limit: params.get("limit") ?? undefined,
      kind: params.get("kind") ?? undefined,
    });
    return Response.json(await readLedger(user.id, query));
  } catch (e) {
    return jsonError(e);
  }
}
