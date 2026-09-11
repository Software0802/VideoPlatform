import { log } from "@/lib/log";
import { listJobIndex } from "@/lib/jobs/index";
import { emitJob } from "@/lib/jobs/events";
import { UNCERTAIN_SUBMIT_CODE } from "@/lib/jobs/retry-guard";
import { isTerminalStatus, type JobPublic, type JobRecord } from "@/lib/jobs/schema";
import { readJob, toPublic, updateJob } from "@/lib/jobs/store";
import { enqueue } from "@/lib/jobs/runner";
import { providerForId } from "@/lib/providers/router";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * 恢复中心（A 包）：给用户一条「自助核验 / 重新驱动」的受控通道，
 * 把「上游可能已接单」的模糊状态变成可以手工推进的对象。
 *
 * 两条动作，都是**不新花钱**的：
 *
 * - `reconcile`（只出现在 `failed + uncertain_submit` 的任务上）：拿我们自己的 jobId
 *   当外部单号去查上游——查得到就接管成 `pending` 继续轮询（上游已经计费，不能再买
 *   一次）；查不到就把 `uncertain_submit` 标记降级成普通失败，一键重试随之解锁
 *   （上游确认没有这单，重试出来的新任务不会重复计费）。
 * - `resume`（非终态任务，或 `expired` 但还带着 `remoteId` 的）：重新入队驱动一次。
 *   待办集合是进程内状态，重启 / 异常掉队的任务靠它和每小时的 `refillTodo` 兜底捡回。
 *
 * 绝不做的那件事：把「结果不确定」的提交原样重发——同一笔上游计费不能赌两遍。
 */

export type RecoveryAction = "reconcile" | "resume";

export type JobRecovery = {
  /** 这一刻这条任务允许的手工恢复动作。 */
  actions: RecoveryAction[];
  /** 为什么会有这条恢复路径（界面上给用户看的一句话）。 */
  reason: string | null;
};

export function recoveryFor(rec: JobRecord): JobRecovery {
  if (!isTerminalStatus(rec.status)) {
    // 非终态：恢复动作是「重新驱动一次」——进程内待办集合在重启 / 异常时可能掉队。
    return { actions: ["resume"], reason: null };
  }
  if (rec.status === "failed" && rec.error?.code === UNCERTAIN_SUBMIT_CODE) {
    try {
      if (providerForId(rec.provider).lookupByExternalId) {
        return {
          actions: ["reconcile"],
          reason: "提交结果未确认：上游可能已接单并计费，可先向上游核验",
        };
      }
    } catch {
      // 认不出的历史 provider id：按「不能查」处理。
    }
    return {
      actions: [],
      reason: "提交结果未确认，且该供应商不支持按外部单号查询，需人工核对上游账单",
    };
  }
  if (rec.status === "expired" && rec.remoteId) {
    // 本地等超时了但远端单号还在：还能把轮询续上，不必重新下单。
    return { actions: ["resume"], reason: "本地已放弃等待，上游可能仍在出片，可以继续轮询" };
  }
  return { actions: [], reason: null };
}

export type ReconcileOutcome = "resumed" | "not_found";

/**
 * 向上游核验一条 `uncertain_submit` 的任务。
 *
 * - 查到远端任务 → 接管成 `pending` 并入队（与 `runner.resolveAmbiguousSubmit` 的
 *   接管路径同一形状）；
 * - 上游明确查无此单 → 摘掉 `uncertain_submit` 标记（任务仍是 `failed`，但一键重试
 *   解锁——上游没有这单，重试出来的新任务不会重复计费）；
 * - 查询本身失败 → 409 `reconcile_failed`，标记原样保留，用户可稍后重试。
 */
export async function reconcileJob(id: string): Promise<{ job: JobPublic; outcome: ReconcileOutcome }> {
  const rec = await readJob(id);
  if (!rec) throw new ProviderHttpError(404, "not_found", "任务不存在");
  if (rec.status !== "failed" || rec.error?.code !== UNCERTAIN_SUBMIT_CODE) {
    throw new ProviderHttpError(409, "conflict", "当前状态无需核验");
  }
  const provider = providerForId(rec.provider);
  if (!provider.lookupByExternalId) {
    throw new ProviderHttpError(409, "not_supported", "该供应商不支持按外部单号查询，需人工核对上游账单");
  }
  let remoteId: string | null;
  try {
    remoteId = await provider.lookupByExternalId(id);
  } catch (error) {
    // 查询挂了 ≠ 查无此单：上游那笔可能存在的计费还没被证伪，标记必须留下。
    log("warn", "reconcile lookup failed", {
      id,
      provider: rec.provider,
      msg: error instanceof Error ? error.message : String(error),
    });
    throw new ProviderHttpError(409, "reconcile_failed", "查询上游失败，请稍后重试");
  }
  if (remoteId) {
    const next = await updateJob(id, (r) => {
      if (r.status !== "failed" || r.error?.code !== UNCERTAIN_SUBMIT_CODE) return r;
      r.remoteId = remoteId;
      r.status = "pending";
      r.error = null;
      r.progress = Math.max(r.progress, 5);
      return r;
    });
    if (next.status === "pending") {
      emitJob(toPublic(next), { type: "status" });
      enqueue(id);
      log("info", "uncertain submit reconciled upstream", { id, remoteId });
      return { job: toPublic(next), outcome: "resumed" };
    }
    return { job: toPublic(next), outcome: "resumed" };
  }
  // 上游确认没有这单：那次提交没有被计费，uncertain 标记降级为普通失败——
  // 一键重试（会建一条全新任务）随之解锁，这正是核验存在的意义。
  const next = await updateJob(id, (r) => {
    if (r.status !== "failed" || r.error?.code !== UNCERTAIN_SUBMIT_CODE) return r;
    r.error = {
      code: "submit_not_accepted",
      message: "上游确认未接收该提交，可安全重试",
      detail: r.error?.detail,
    };
    return r;
  });
  emitJob(toPublic(next), { type: "status" });
  return { job: toPublic(next), outcome: "not_found" };
}

/**
 * 重新驱动一条任务：
 *
 * - 非终态 → 重新入队（`pump` 会按 `status` 接着跑：queued 提交、pending 轮询、
 *   persisting 落盘）；
 * - `expired` 且带 `remoteId` → 转回 `pending` 再入队，把放弃掉的轮询续上。
 *
 * 终态其余情况（成功 / 取消 / 无 remoteId 的过期）409——它们没有可以「续」的东西。
 */
export async function resumeJob(id: string): Promise<JobPublic> {
  const rec = await readJob(id);
  if (!rec) throw new ProviderHttpError(404, "not_found", "任务不存在");
  if (!isTerminalStatus(rec.status)) {
    enqueue(id);
    return toPublic(rec);
  }
  if (rec.status === "expired" && rec.remoteId) {
    const next = await updateJob(id, (r) => {
      if (r.status !== "expired" || !r.remoteId) return r;
      r.status = "pending";
      r.error = null;
      return r;
    });
    if (next.status === "pending") {
      emitJob(toPublic(next), { type: "status" });
      enqueue(id);
      return toPublic(next);
    }
    return toPublic(next);
  }
  throw new ProviderHttpError(409, "conflict", "当前状态无法恢复执行");
}

/** 该用户所有「需要人看一眼」的恢复条目（恢复中心列表用）。 */
export async function listRecoveryItems(ownerId: string): Promise<{ job: JobPublic; recovery: JobRecovery }[]> {
  const [nonTerminal, terminal] = await Promise.all([
    listJobIndex({ ownerId, nonTerminal: true }),
    listJobIndex({ ownerId, status: ["failed", "expired"] }),
  ]);
  const out: { job: JobPublic; recovery: JobRecovery }[] = [];
  for (const entry of [...nonTerminal, ...terminal]) {
    const rec = await readJob(entry.id);
    if (!rec) continue;
    const recovery = recoveryFor(rec);
    if (recovery.actions.length || recovery.reason) out.push({ job: toPublic(rec), recovery });
  }
  return out;
}
