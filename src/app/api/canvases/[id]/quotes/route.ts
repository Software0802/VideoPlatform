import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { computeQuote } from "@/lib/canvas/graph";
import { readCanvas } from "@/lib/canvas/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 整图报价（D 包）：校验图 → 逐生成节点归一报价 → 总价 + `quoteHash`。
 * 不落盘——创建 run 时重算比对，图变 / 价变 / revision 变即 409 `quote_stale`。
 */
async function quote(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    const doc = await readCanvas(user.id, id);
    if (!doc) {
      return Response.json({ error: { code: "not_found", message: "画布不存在" } }, { status: 404 });
    }
    const result = await computeQuote(user.id, doc);
    return Response.json({ canvasId: doc.id, revision: doc.revision, quote: result });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(quote);
