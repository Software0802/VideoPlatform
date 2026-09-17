/**
 * 留存窗口的纯计算（review 2026-09-15 B-05）。
 *
 * 清理判定（`retention.ts`）与「还剩几天」的对外派生字段（`store.ts` 的 `toPublic`）
 * 必须用同一份日期算术，否则界面会预告一个与实际清理时刻不同的日子。这里只放不碰
 * 磁盘、不读环境变量的纯函数，两边都 import 它——`retention.ts` 会 import `store.ts`，
 * 把这段算术留在任何一边都要制造 import 环。
 */

export const DAY_MS = 86_400_000;

/** 清理与配额共用的「结算时刻」字段。 */
export type RetentionTimestamps = {
  updatedAt: string;
  completedAt?: string;
};

/**
 * 哪一刻起算任务的年龄。与配额的 `settledAtMs`（`completedAt ?? updatedAt`）刻意一致：
 * 两者必须对「任务什么时候结束的」有同一个答案，否则一条记录会按一个钟被清、按另一个
 * 钟被计费。
 */
export function settledAtMs(job: RetentionTimestamps): number | null {
  const ms = Date.parse(job.completedAt ?? job.updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 产物到期时刻（ms）。`retentionDays <= 0` = 留存关闭，永不到期；结算时刻不可解析时
 * 同样返回 null——`shouldPurgeArtifacts` 在这两种情况下也不会清。
 *
 * 注意这是「够 N 天即可被清」的那一刻（清理判据是 `now - settled >= N 天`），真正的
 * 删除发生在其后的第一次维护 tick（每小时整点），所以它是下界而不是精确删除时刻。
 */
export function artifactsExpireAtMs(
  job: RetentionTimestamps,
  retentionDays: number,
): number | null {
  if (retentionDays <= 0) return null;
  const settled = settledAtMs(job);
  if (settled === null) return null;
  return settled + retentionDays * DAY_MS;
}
