import { z } from "zod";
import { loadBalanceUsage } from "@/lib/billing/admission";
import { costRatio, listPlans } from "@/lib/billing/plans";
import {
  InsufficientBalanceError,
  publicSubscription,
  purchaseSubscription,
  settleSubscription,
} from "@/lib/billing/subscription";
import { jsonError } from "@/lib/http";
import { subscriptionCycleSchema, subscriptionPlanIdSchema } from "@/lib/users/schema";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * `POST` 只认这三个字段；strict，多一个键就是 400（与 `createJobBodySchema` 同一纪律）。
 *
 * `idempotencyKey` 是**必填**的，与 `POST /api/jobs` 的可选不同：那边重复提交最多多出
 * 一条任务，这边多出的是一笔订阅费。校验只管形状（非空字符串、给个长度上限挡垃圾），
 * 语义（同 key = 同一次购买）在 `purchaseSubscription` 里按流水判。
 */
const purchaseBodySchema = z.strictObject({
  planId: subscriptionPlanIdSchema,
  cycle: subscriptionCycleSchema,
  idempotencyKey: z.string().min(1).max(200),
});

/**
 * 订阅档位与我的订阅（方案 §3.1 / §3.3）。
 *
 * 先 `settleSubscription` 再读：结算是惰性的（没有定时任务），这一页正是最常被打开的
 * 那个入口，到期清零 / 跨期重置 / 今天的日积分都在这一步落地。
 *
 * `plans[].features` 下发的是 **i18n 键名**，服务端不翻译——多语言的事实源在
 * `src/lib/i18n/messages/`，服务端再翻一遍就有两处文案会漂移。
 *
 * 这里**不下发**成本比例与毛利率：那是我们的进货价与加价幅度，摆到浏览器里等于把
 * 上游成本公开给任何按 F12 的人。页面脚注只说「价格按平台成本加固定毛利率算」，
 * 具体数字留在服务端（`src/lib/billing/plans.ts`）。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const settled = await settleSubscription(user.id);
    // 四档共用同一次 `costRatio()`：分别算的话，一次读产品目录的中途变更就能让四档
    // 落在两个基准上。
    return Response.json({
      plans: listPlans(costRatio()),
      mine: publicSubscription(settled),
    });
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * 购买。扣的是**已购余额**（礼品码 / 管理员充值），会员积分买不了订阅——否则
 * 「买订阅得积分 → 用积分再买订阅」就是无限套利（方案 §0）。
 *
 * 402 的载荷在标准信封之外多带 `needCny` / `purchasableCny`：页面要说清「还差多少」，
 * 而「现在有多少」报的是**扣掉在途任务预留之后**还能买的钱，与判据同一个数。
 * 信封本身保持 `{error:{code,message}}` 不变，`@/lib/client/http` 的 `ApiError.code`
 * 因此照常拿得到 `insufficient_balance`。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = purchaseBodySchema.parse(await request.json());
    const result = await purchaseSubscription(
      user.id,
      body.planId,
      body.cycle,
      body.idempotencyKey,
    );
    const balance = await loadBalanceUsage(user.id);
    return Response.json({
      mine: publicSubscription(result.user),
      balance,
      paidCny: result.paidCny,
      replay: result.replay,
    });
  } catch (e) {
    if (e instanceof InsufficientBalanceError) {
      return Response.json(
        {
          error: { code: e.code, message: e.message },
          needCny: e.needCny,
          purchasableCny: e.purchasableCny,
        },
        { status: 402 },
      );
    }
    return jsonError(e);
  }
}
