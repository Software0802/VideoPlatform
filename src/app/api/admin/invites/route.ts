import { z } from "zod";
import { jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { withRequestContext } from "@/lib/request-context";
import { actorLabel, requireAdminActor } from "@/lib/users/admin-auth";
import { createInvite } from "@/lib/users/invites";

export const runtime = "nodejs";

/**
 * `POST /api/admin/invites`：`scripts/mint-invites.mjs` 的服务端等价物——
 * 铸 `count` 个一次性邀请码（1–500），可选备注。响应里的码只应到达
 * 管理员的终端，不进日志。
 */
const bodySchema = z
  .object({
    count: z.number().int().min(1).max(500).default(1),
    note: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

async function post(request: Request) {
  try {
    const actor = await requireAdminActor(request);
    const body = bodySchema.parse(await request.json());
    const codes: string[] = [];
    for (let i = 0; i < body.count; i += 1) {
      codes.push((await createInvite(body.note)).code);
    }
    log("info", "admin invites minted", {
      actor: actorLabel(actor),
      count: body.count,
    });
    return Response.json({ codes }, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(post);
