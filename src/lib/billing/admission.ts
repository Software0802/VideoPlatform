import { isTerminalStatus } from "@/lib/jobs/schema";
import { listJobRecordsForUser } from "@/lib/jobs/store";
import { ProviderHttpError } from "@/lib/providers/types";
import { readUser } from "@/lib/users/store";

/**
 * 余额准入（方案 §3.2）——取代日配额成为主闸门。
 *
 * 模型和配额那边一样是**预留 + 结算**，只是单位从「次」换成「元」：
 *
 *   reserved  = 该用户所有非终态任务的售价之和
 *   available = balance − reserved
 *   放行      = available ≥ 本次售价
 *
 * 预留不写盘：它就是「在途任务的 priceCny 之和」，从 job.json 现算。任务转终态时
 * 预留自然消失，成功的那一刻在 `store.updateJob` 里真扣钱，失败 / 取消 / 过期则
 * 什么都不扣——「上游挂了不该用户掏钱」和配额那边是同一条纪律。
 */

export type BalanceUsage = {
  balanceCny: number;
  /** 在途任务占住的钱，还没扣，但不能再拿去下单。 */
  reservedCny: number;
  availableCny: number;
};

/** 现算一个用户的余额与在途预留。 */
export async function loadBalanceUsage(userId: string): Promise<BalanceUsage> {
  const [user, jobs] = await Promise.all([readUser(userId), listJobRecordsForUser(userId)]);
  const balanceCny = user?.balanceCny ?? 0;
  let reservedCny = 0;
  for (const job of jobs) {
    // 管理员能看到无主的历史任务（`canAccessJob`），但那些任务不属于任何人的余额，
    // 口径与 `quota.ts` 的 in-flight 完全一致：只数 ownerId 相等的非终态任务。
    if (job.ownerId !== userId) continue;
    if (isTerminalStatus(job.status)) continue;
    const price = typeof job.priceCny === "number" && Number.isFinite(job.priceCny) ? job.priceCny : 0;
    reservedCny += price;
  }
  reservedCny = round2(reservedCny);
  return { balanceCny, reservedCny, availableCny: round2(balanceCny - reservedCny) };
}

/**
 * 唯一的余额判官，`createJob` 与 `retryJob` 共用——重试同样会向上游发一次计费请求，
 * 花的是一样的钱。
 *
 * 必须在 `withAdmissionLock` 里、与它守护的 `writeJob` 同一个临界区调用：出了锁，
 * 五个并发请求会读到同一份「还够一次」的余额然后一起放行。
 */
export async function assertBalance(userId: string, priceCny: number): Promise<void> {
  const usage = await loadBalanceUsage(userId);
  if (usage.availableCny < priceCny) {
    throw new ProviderHttpError(402, "insufficient_balance", "余额不足，请充值");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
