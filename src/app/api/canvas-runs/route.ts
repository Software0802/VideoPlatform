import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { canvasRunCreateBodySchema } from "@/lib/canvas/schema";
import { createCanvasRun } from "@/lib/canvas/dag";

export const runtime = "nodejs";

/**
 * 创建一次整图运行（D 包）：`{canvasId, quoteHash, idempotencyKey}`。
 * 同 key 同参重放交回原 run，异参 409；报价过期 / 图已改 → 409 `quote_stale`。
 */
async function create(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    const body = canvasRunCreateBodySchema.parse(await request.json());
    const { run, replay } = await createCanvasRun(user.id, body);
    return Response.json({ run }, { status: replay ? 200 : 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(create);
