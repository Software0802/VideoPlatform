import { listJobIndex } from "@/lib/jobs/index";

/**
 * 「现在有多少任务在跑」的两种读法（方案 §3.2「安全收口」「可观测性」）。
 *
 * `runner.ts` 里已经有一个全站口径的 `activeCount()`；这里补的是它没有、而准入与
 * health 需要的两个切面：按用户数、按「排队 / 执行中」拆分。判据只有一条——
 * **非终态即在途**，与 `quota.ts` / `admission.ts` 的预留口径完全一致，免得三处各写
 * 一份状态名单，日后加一个 harness 阶段就漏掉一处。
 *
 * 都走 `listJobIndex`（方案 §3.3 的派生索引）而不是逐个读 job.json：这两个函数分别
 * 挂在每次提交和每次健康检查上，全量读盘会随历史任务线性变慢。
 */

/**
 * 这个账号名下还没走到终态的任务数。
 *
 * 用 `ownerId` 而不是 `forUser`：管理员看得见的无主历史任务不属于任何人的在途额度，
 * 与 `quota.ts` / `admission.ts` 数预留时的口径一致。
 */
export async function activeCountForUser(ownerId: string): Promise<number> {
  const entries = await listJobIndex({ ownerId, nonTerminal: true });
  return entries.length;
}

export type QueueStats = {
  /** 还没被 runner 拿起来的（含退避中等待重试的）。 */
  queued: number;
  /** 已经在跑的：提交中 / 轮询中 / 落盘中 / 长片各阶段。 */
  running: number;
};

/**
 * 队列积压快照，给 `/api/health` 用。
 *
 * `queued` 持续偏高说明并发不够或有任务卡在退避里，`running` 持续偏高说明上游慢——
 * 两个数分开才看得出是哪一种，合成一个总数反而什么都说明不了。
 */
export async function queueStats(): Promise<QueueStats> {
  const entries = await listJobIndex({ nonTerminal: true });
  let queued = 0;
  for (const entry of entries) if (entry.status === "queued") queued += 1;
  return { queued, running: entries.length - queued };
}

/**
 * runner 起没起来。
 *
 * 直接读 `runner.ts` 挂在 `globalThis` 上的那份状态，而不是让 runner 导出一个读取
 * 函数：本轮改动的范围里 runner 只允许加一行日志上下文，不能加新导出。它是只读的
 * 探测，写入方仍然只有 runner 自己；形状对不上（字段被改名）就当没起来，
 * health 会因此报 `runner.started=false`，那正是要人去看一眼的信号。
 */
export function runnerStarted(): boolean {
  const g = globalThis as typeof globalThis & { __lumenRunner?: { started?: boolean } };
  return g.__lumenRunner?.started === true;
}
