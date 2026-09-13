import { z } from "zod";
import { jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { withRequestContext } from "@/lib/request-context";
import {
  actorLabel,
  adminUserNotFound,
  findAdminTargetUser,
  requireAdminActor,
} from "@/lib/users/admin-auth";
import { generatePassword } from "@/lib/users/password";
import { changeUserPassword } from "@/lib/users/service";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * `POST /api/admin/users/[id]/password`：`scripts/reset-password.mjs` 的服务端
 * 等价物——复用 `changeUserPassword`（hashPassword + `sessionEpoch` 递增，
 * 全设备掉线）。不显式给 `password` 时服务端生成 12 位随机口令并在响应里
 * 只回这一次（与 CLI 打到 stdout 同一约定）。`[id]` 接受 `usr_*` 或邮箱。
 */
const bodySchema = z
  .object({
    password: z.string().min(8).max(200).optional(),
  })
  .strict();

async function post(request: Request, ctx: Ctx) {
  try {
    const actor = await requireAdminActor(request);
    const { id } = await ctx.params;
    const body = bodySchema.parse(await request.json());
    const user = await findAdminTargetUser(id);
    if (!user) throw adminUserNotFound();
    const password = body.password ?? generatePassword(12);
    const next = await changeUserPassword(user.id, password);
    log("info", "admin password reset", {
      actor: actorLabel(actor),
      userId: user.id,
    });
    return Response.json({
      user: { id: user.id, email: user.email },
      password,
      sessionEpoch: next.sessionEpoch,
    });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(post);
