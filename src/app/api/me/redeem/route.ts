import { loadBalanceUsage } from "@/lib/billing/admission";
import { jsonError } from "@/lib/http";
import { ProviderHttpError } from "@/lib/providers/types";
import { redeemGiftCode } from "@/lib/users/gift-codes";
import { clientIp, consumeRateLimit } from "@/lib/users/rate-limit";
import { redeemBodySchema } from "@/lib/users/schema";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 每分钟 5 次，IP 与用户各一个桶（和登录一样：换 IP 或换账号都不能刷新配额）。
 * 比登录的 10 次更紧：码空间虽然有 60 bit，但暴力猜码没有任何正当用途。
 */
const REDEEM_RATE_LIMIT = 5;

/**
 * 兑换礼品码（方案 §1.7）。成功返回 `{ amountCny, balance, alreadyCredited }`，`balance`
 * 与 `GET /api/me` 的同名字段同形状，前端拿到就能直接覆盖顶栏读数。
 *
 * `alreadyCredited` 为真时这次没有真的加钱：上一次兑换已经入过账，只是崩在写
 * `creditedAt` 之前（见 `redeemGiftCode` 的崩溃语义）。原样透传而不是吞掉——界面照旧
 * 报「到账 ¥x」的话，用户会以为充了两次。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = redeemBodySchema.parse(await request.json());
    const gate = consumeRateLimit([`redeem:ip:${clientIp(request)}`, `redeem:user:${user.id}`], {
      limit: REDEEM_RATE_LIMIT,
    });
    if (!gate.allowed) {
      throw new ProviderHttpError(
        429,
        "rate_limited",
        `兑换请求过于频繁，请 ${gate.retryAfterSec} 秒后再试`,
      );
    }
    const redemption = await redeemGiftCode(body.code, user.id);
    const balance = await loadBalanceUsage(user.id);
    return Response.json({
      amountCny: redemption.amountCny,
      balance,
      alreadyCredited: redemption.alreadyCredited,
    });
  } catch (e) {
    return jsonError(e);
  }
}
