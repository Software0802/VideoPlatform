import { listJobIndex } from "@/lib/jobs/index";
import { ProviderHttpError } from "@/lib/providers/types";
import { activeMemberCreditsCny } from "@/lib/users/schema";
import { readUser } from "@/lib/users/store";

/**
 * 余额准入（方案 §3.2）——取代日配额成为主闸门。
 *
 * 模型和配额那边一样是**预留 + 结算**，只是单位从「次」换成「元」：
 *
 *   reserved  = 该用户所有非终态任务的售价之和
 *   available = 已购余额 + **有效**会员积分池 − reserved
 *   放行      = available ≥ 本次售价
 *
 * 预留不写盘：它就是「在途任务的 priceCny 之和」，从 job.json 现算。任务转终态时
 * 预留自然消失，成功的那一刻在 `store.updateJob` 里真扣钱，失败 / 取消 / 过期则
 * 什么都不扣——「上游挂了不该用户掏钱」和配额那边是同一条纪律。
 */

export type BalanceUsage = {
  /** 已购池：礼品码 / 管理员充值进来的钱。买订阅只能花这个池。 */
  balanceCny: number;
  /** 会员积分池**账面**余量：`user.json` 里的数，可能还没被结算清掉（方案 §3.2）。 */
  memberCreditsCny: number;
  /**
   * 这一刻真正能花的会员积分：订阅已过期（或没有订阅）时是 0，即使 `memberCreditsCny`
   * 还是正数。判定一律用这个数，不用上面那个账面值。
   */
  effectiveMemberCny: number;
  /** 在途任务占住的钱，还没扣，但不能再拿去下单。 */
  reservedCny: number;
  /** `balanceCny + effectiveMemberCny − reservedCny`：这一刻还能下多少单。 */
  availableCny: number;
};

/**
 * 现算一个用户的余额与在途预留。
 *
 * 在途预留走 `data/jobs/index.json`（方案 §3.3）：这一步在 `withAdmissionLock` 的临界区
 * 里，每一次提交都要跑，之前它要把全站每一份 job.json 都读一遍——历史任务越多，下单越
 * 慢。索引里 `ownerId` / `status` / `priceCny` 三个字段就够算预留，**判定口径一个字没变**。
 *
 * 管理员能看到无主的历史任务（`canAccessJob`），但那些任务不属于任何人的余额，所以这里
 * 按 `ownerId` 精确筛，不用可见性口径——与 `quota.ts` 的 in-flight 完全一致。
 */
export async function loadBalanceUsage(
  userId: string,
  now: number = Date.now(),
): Promise<BalanceUsage> {
  const [user, entries] = await Promise.all([
    readUser(userId),
    listJobIndex({ ownerId: userId, nonTerminal: true }),
  ]);
  const balanceCny = user?.balanceCny ?? 0;
  const memberCreditsCny = user?.memberCreditsCny ?? 0;
  // 两个池都能付任务的钱（扣的时候会员池优先），所以准入看的是两池之和——但会员池只在
  // 订阅有效期内算数。本函数不自己做结算：它在 `withAdmissionLock` 临界区内跑、拿不到
  // 用户锁（锁序恒为 admission → user，反过来就是死锁）。跨期清零由 `assertBalance` 在
  // 进临界区判余额之前先跑 `settleSubscription` 完成（R05）；`purchaseSubscription` 也
  // 在锁内先调 `settleSubscriptionLocked`。直接读账面 `memberCreditsCny` 等于让没结算的
  // 旧期积分继续花，所以判定一律走 `activeMemberCreditsCny`。
  const effectiveMemberCny = activeMemberCreditsCny(user, now);
  let reservedCny = 0;
  for (const job of entries) {
    const price = typeof job.priceCny === "number" && Number.isFinite(job.priceCny) ? job.priceCny : 0;
    reservedCny += price;
  }
  reservedCny = round2(reservedCny);
  return {
    balanceCny,
    memberCreditsCny,
    effectiveMemberCny,
    reservedCny,
    availableCny: round2(balanceCny + effectiveMemberCny - reservedCny),
  };
}

/**
 * 这一刻能拿去**买订阅**的钱（人民币元）。
 *
 * 订阅只花已购池（会员积分买订阅 = 无限套利），但已购池里有一部分可能已经被在途任务
 * 占住了：在途预留先由有效会员积分顶，顶不住的那部分才落到已购池上，于是
 *
 *   可购 = balanceCny − max(0, reservedCny − effectiveMemberCny)
 *
 * 不减这一块的话，「先提交五条任务、再把余额买成订阅」就能让那五条任务结算时把已购池
 * 扣成负数——预留模型在准入那边守住了任务，购买这条路不守就等于开了个后门。
 */
export function purchasableCny(usage: BalanceUsage): number {
  return round2(usage.balanceCny - Math.max(0, usage.reservedCny - usage.effectiveMemberCny));
}

/**
 * 唯一的余额判官，`createJob` 与 `retryJob` 共用——重试同样会向上游发一次计费请求，
 * 花的是一样的钱。
 *
 * 必须在 `withAdmissionLock` 里、与它守护的 `writeJob` 同一个临界区调用：出了锁，
 * 五个并发请求会读到同一份「还够一次」的余额然后一起放行。
 */
export async function assertBalance(userId: string, priceCny: number): Promise<void> {
  // R05：判定之前先把当前期结算掉。结算是惰性的（原本只有 `GET /api/me` /
  // `/api/subscription` 触发），不在这里做的话，年付用户跨期后还没被任何读路径碰过，
  // 上一期没花完的会员积分就会照账面放行——那笔钱本该在跨期那一刻清零。锁序不破：
  // 调用方恒在 `withAdmissionLock` 内，结算内部拿 `withUserLock`，仍是 admission → user。
  // 动态 import 是因为 `subscription.ts` 反向引用本文件的 `loadBalanceUsage`。
  const { settleSubscription } = await import("@/lib/billing/subscription");
  await settleSubscription(userId);
  const usage = await loadBalanceUsage(userId);
  if (usage.availableCny < priceCny) {
    throw new ProviderHttpError(402, "insufficient_balance", "余额不足，请充值");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
