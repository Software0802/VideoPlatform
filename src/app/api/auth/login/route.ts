import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { ProviderHttpError } from "@/lib/providers/types";
import { authRateKeys, consumeRateLimit } from "@/lib/users/rate-limit";
import { loginBodySchema, toPublicUser } from "@/lib/users/schema";
import { issueSessionCookie } from "@/lib/users/session";
import { loginUser } from "@/lib/users/service";

export const runtime = "nodejs";

async function handler(request: Request) {
  try {
    const body = loginBodySchema.parse(await request.json());
    const gate = consumeRateLimit(authRateKeys(request, "login", body.email));
    if (!gate.allowed) {
      throw new ProviderHttpError(
        429,
        "rate_limited",
        `登录请求过于频繁，请 ${gate.retryAfterSec} 秒后再试`,
      );
    }
    const user = await loginUser(body);
    const res = Response.json(toPublicUser(user));
    res.headers.append("Set-Cookie", issueSessionCookie(user, request));
    return res;
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(handler);
