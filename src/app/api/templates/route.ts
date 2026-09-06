import { jsonError } from "@/lib/http";
import { listTemplates } from "@/lib/templates";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 模板清单（方案 §1.4「模板 tab」）。内容对所有登录用户都一样，但仍然要会话——
 * `/api/*` 的默认就是要会话，模板文案属于产品内容，没有理由对未登录的抓取者开放。
 *
 * 目录不存在时返回空数组（首次部署还没把 `data-seed/templates` 拷过去），不是 500。
 */
export async function GET(request: Request) {
  try {
    await requireUser(request);
    const templates = await listTemplates();
    return Response.json({ templates });
  } catch (e) {
    return jsonError(e);
  }
}
