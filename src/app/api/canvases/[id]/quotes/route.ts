import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { requireUser } from "@/lib/users/session";
import { computeQuote, expandRegenerate } from "@/lib/canvas/graph";
import { resolveReuseForQuote } from "@/lib/canvas/dag";
import { readCanvas } from "@/lib/canvas/store";
import { canvasQuoteBodySchema } from "@/lib/canvas/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 整图报价（D 包）：校验图 → 逐生成节点归一报价 → 总价 + `quoteHash`。
 * 不落盘——创建 run 时重算比对，图变 / 价变 / revision 变即 409 `quote_stale`。
 * D 切片二：请求体可带 `regenerate`（强制重跑点名的生成节点，报价按实计价、
 * 不复用历史产物）；空体兼容。
 */
async function quote(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    // 空 body / 非 JSON 都按「无 regenerate」处理——报价本可以不带体。
    const raw = await request.json().catch(() => ({}));
    const body = canvasQuoteBodySchema.parse(raw ?? {});
    const doc = await readCanvas(user.id, id);
    if (!doc) {
      return Response.json({ error: { code: "not_found", message: "画布不存在" } }, { status: 404 });
    }
    const graph = { nodes: doc.nodes, edges: doc.edges };
    const genIds = new Set(graph.nodes.filter((n) => n.kind === "gen_image" || n.kind === "gen_video").map((n) => n.id));
    for (const nodeId of body.regenerate ?? []) {
      if (!genIds.has(nodeId)) {
        return Response.json(
          { error: { code: "invalid_argument", message: "重跑名单里有非生成节点" } },
          { status: 400 },
        );
      }
    }
    const reuse = await resolveReuseForQuote(user.id, doc, expandRegenerate(graph, body.regenerate ?? []));
    const result = await computeQuote(user.id, doc, { regenerate: body.regenerate, reuse });
    return Response.json({ canvasId: doc.id, revision: doc.revision, quote: result });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(quote);
