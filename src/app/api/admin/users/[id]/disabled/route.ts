import { z } from "zod";
import { jsonError } from "@/lib/http";
import { log } from "@/lib/log";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";
import {
  actorLabel,
  adminUserNotFound,
  findAdminTargetUser,
  requireAdminActor,
} from "@/lib/users/admin-auth";
import { withUserLock } from "@/lib/users/lock";
import { readUser, writeUser } from "@/lib/users/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * `POST /api/admin/users/[id]/disabled`：`scripts/disable-user.mjs` 的服务端
 * 等价物——停用/恢复都写 `disabled` 并把 `sessionEpoch` 加一（在途会话立即
 * 失效），恢复时删掉字段而不是写 false。`[id]` 接受 `usr_*` 或邮箱。
 * 整个读-改-写在 `withUserLock` 里，与注册/改密同一把串行锁。
 */
const bodySchema = z.object({ disabled: z.boolean() }).strict();

async function post(request: Request, ctx: Ctx) {
  try {
    const actor = await requireAdminActor(request);
    const { id } = await ctx.params;
    const body = bodySchema.parse(await request.json());
    const target = await findAdminTargetUser(id);
    if (!target) throw adminUserNotFound();
    let noop = false;
    const next = await withUserLock(async () => {
      const user = await readUser(target.id);
      if (!user) throw new ProviderHttpError(404, "not_found", "用户不存在");
      noop = (user.disabled === true) === body.disabled;
      const updated = { ...user, sessionEpoch: user.sessionEpoch + 1 };
      if (body.disabled) updated.disabled = true;
      else delete updated.disabled;
      return writeUser(updated);
    });
    log("info", "admin user disabled toggle", {
      actor: actorLabel(actor),
      userId: target.id,
      disabled: body.disabled,
    });
    return Response.json({
      user: { id: target.id, email: target.email },
      disabled: next.disabled === true,
      sessionEpoch: next.sessionEpoch,
      noop,
    });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(post);
