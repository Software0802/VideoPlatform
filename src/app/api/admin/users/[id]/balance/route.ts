import { z } from "zod";
import { applyBalanceChange } from "@/lib/billing/ledger";
import { jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { withRequestContext } from "@/lib/request-context";
import {
  actorLabel,
  adminUserNotFound,
  findAdminTargetUser,
  requireAdminActor,
} from "@/lib/users/admin-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * `POST /api/admin/users/[id]/balance`：`scripts/grant-balance.mjs` 的服务端
 * 等价物。参数一一对应：金额（元，可为负）、备注、`ref` 幂等键；只动已购池，
 * 与脚本同一个口径（会员池不归管理员手工调）。`[id]` 接受 `usr_*` 或邮箱。
 *
 * 入账仍走 `applyBalanceChange`——同 `ref` 重放返回原记录、同键异输入
 * 409 `billing_idempotency_conflict`，不另开资金入口。
 */
const bodySchema = z
  .object({
    amountCny: z
      .number()
      .finite()
      .refine((n) => n !== 0, "金额必须是非 0 的数字（元）"),
    note: z.string().trim().min(1).max(200).optional(),
    ref: z.string().trim().min(1).max(120).optional(),
    pool: z.literal("purchased").optional(),
  })
  .strict();

async function post(request: Request, ctx: Ctx) {
  try {
    const actor = await requireAdminActor(request);
    const { id } = await ctx.params;
    const body = bodySchema.parse(await request.json());
    const user = await findAdminTargetUser(id);
    if (!user) throw adminUserNotFound();
    const next = await applyBalanceChange(
      user.id,
      body.amountCny,
      {
        kind: "grant",
        amountCny: body.amountCny,
        ...(body.note ? { note: body.note } : {}),
        ...(body.ref ? { ref: body.ref } : {}),
      },
      { pool: "purchased" },
    );
    log("info", "admin balance change", {
      actor: actorLabel(actor),
      userId: user.id,
      amountCny: body.amountCny,
      ref: body.ref,
    });
    return Response.json({
      user: { id: user.id, email: user.email },
      beforeCny: user.balanceCny,
      afterCny: next.balanceCny,
    });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(post);
