import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { canvasPatchBodySchema } from "@/lib/canvas/schema";
import { deleteCanvas, patchCanvas, readCanvas } from "@/lib/canvas/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 非本人与不存在同 404：拒绝的理由不泄露 id 是否真实存在。 */
function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "画布不存在" } }, { status: 404 });
}

async function detail(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const doc = await readCanvas(user.id, id);
    if (!doc) return notFound();
    return Response.json({ canvas: doc });
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * 乐观并发写：`expectedRevision` 对不上就 409 `revision_conflict`——两个标签页
 * 各拿各的底稿，慢的一边不会被静默覆盖；冲突方重新 GET 拿最新文档再改。
 */
async function patch(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const body = canvasPatchBodySchema.parse(await request.json());
    const next = await patchCanvas(user.id, id, body);
    if (!next) return notFound();
    return Response.json({ canvas: next });
  } catch (e) {
    return jsonError(e);
  }
}

async function remove(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const ok = await deleteCanvas(user.id, id);
    if (!ok) return notFound();
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(detail);
export const PATCH = withRequestContext(patch);
export const DELETE = withRequestContext(remove);
