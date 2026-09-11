import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { canvasCreateBodySchema } from "@/lib/canvas/schema";
import { createCanvas, listCanvases } from "@/lib/canvas/store";

export const runtime = "nodejs";

/** 画布列表（C 包）：只下发 id/标题/时间，正文走详情。 */
async function list(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    return Response.json({ canvases: await listCanvases(user.id) });
  } catch (e) {
    return jsonError(e);
  }
}

async function create(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request);
    const body = canvasCreateBodySchema.parse(await request.json().catch(() => ({})));
    const doc = await createCanvas(user.id, body.title);
    return Response.json({ canvas: doc }, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
export const POST = withRequestContext(create);
