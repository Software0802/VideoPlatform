import { jsonError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { reconcileRelays } from "@/lib/providers/relay/assemble";
import { fetchRelayModels } from "@/lib/providers/relay/discover";
import { relayViewFor } from "@/lib/providers/relay/live";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";

export const runtime = "nodejs";

/**
 * `POST /api/admin/relays/:id/discover`：拉一次上游 `GET /models`，写
 * `data/relay-catalog/<id>.json` 快照并重建注册，返回模型列表与相对当前目录的
 * diff。key 缺失 / 上游报错原样冒上来，不写快照。
 */
async function discover(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await ctx.params;
    const view = relayViewFor(id);
    if (!view) {
      throw new ProviderHttpError(404, "not_found", `relay ${id} 不存在`);
    }
    const before = view.catalog ? Object.keys(view.catalog.table()) : [];
    const result = await fetchRelayModels(view, before);
    // 快照变了 → 重建 view（catalogSource=models-endpoint 的目录下次读就是新表）。
    reconcileRelays();
    return Response.json(result);
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(discover);
