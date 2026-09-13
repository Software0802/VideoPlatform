import { jsonError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { createRelay, listRelays } from "@/lib/providers/relay/manage";
import { withRequestContext } from "@/lib/request-context";

export const runtime = "nodejs";

/**
 * `GET /api/admin/relays`：全部 relay（含 env 折算的 yman / openai 预设）。
 * 响应只含 keyEnv 名与 hasKey，绝不回显 key 值。
 */
async function list(request: Request) {
  try {
    await requireAdmin(request);
    return Response.json({ relays: listRelays() });
  } catch (e) {
    return jsonError(e);
  }
}

/** `POST /api/admin/relays`：新增一条 relay 配置，落盘后立刻 reconcile。 */
async function create(request: Request) {
  try {
    await requireAdmin(request);
    const relay = await createRelay(await request.json());
    return Response.json({ relay }, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = withRequestContext(list);
export const POST = withRequestContext(create);
