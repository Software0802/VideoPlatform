import { jsonError } from "@/lib/http";
import { toPublicUser } from "@/lib/users/schema";
import { sessionUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * The caller's own account. Quota fields (plan §6) land here in the next batch;
 * the shape is `{ userId, email, plan }` and only grows.
 */
export async function GET(request: Request) {
  try {
    const user = await sessionUser(request);
    if (!user) {
      return Response.json(
        { error: { code: "unauthorized", message: "请先登录" } },
        { status: 401 },
      );
    }
    return Response.json(toPublicUser(user));
  } catch (e) {
    return jsonError(e);
  }
}
