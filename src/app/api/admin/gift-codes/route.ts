import { z } from "zod";
import { jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { withRequestContext } from "@/lib/request-context";
import { actorLabel, requireAdminActor } from "@/lib/users/admin-auth";
import { createGiftCode } from "@/lib/users/gift-codes";

export const runtime = "nodejs";

/**
 * `POST /api/admin/gift-codes`：`scripts/mint-gift-codes.mjs` 的服务端等价物——
 * 铸 `count` 张面额 `amountCny` 元的自助充值码（数量 1–500、面额 ≤ 100000）。
 * 一张码就是一笔钱：响应里的码只应到达管理员的终端，不进日志。
 */
const bodySchema = z
  .object({
    count: z.number().int().min(1).max(500),
    amountCny: z.number().finite().positive().max(100000),
    note: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

async function post(request: Request) {
  try {
    const actor = await requireAdminActor(request);
    const body = bodySchema.parse(await request.json());
    const codes: string[] = [];
    for (let i = 0; i < body.count; i += 1) {
      codes.push((await createGiftCode(body.amountCny, body.note)).code);
    }
    log("info", "admin gift codes minted", {
      actor: actorLabel(actor),
      count: body.count,
      amountCny: body.amountCny,
    });
    return Response.json({ codes, amountCny: body.amountCny }, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(post);
