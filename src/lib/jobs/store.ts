import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyBalanceChange, latestMemberDebitAt } from "@/lib/billing/ledger";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { upsertJobIndex } from "@/lib/jobs/index";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import {
  clampProgress,
  isTerminalStatus,
  jobPublicSchema,
  type JobPublic,
  type JobRecord,
} from "@/lib/jobs/schema";
import { canAccessJob } from "@/lib/jobs/ownership";
import { subscriptionActive } from "@/lib/users/schema";
import { readUser } from "@/lib/users/store";
import { retryBlock } from "@/lib/jobs/retry-guard";
import { mediaStore } from "@/lib/storage/local-fs";

type GlobalLockState = typeof globalThis & {
  __lumenJobLocks?: Map<string, Promise<void>>;
};

const globalLockState = globalThis as GlobalLockState;
const locks = globalLockState.__lumenJobLocks ?? (globalLockState.__lumenJobLocks = new Map());

/**
 * 一条任务的串行队列（进程级，键是 jobId，队尾挂在 `globalThis` 上所以 Next dev 把同一份
 * 文件打进多张图时也仍然串行）。
 *
 * 导出是给 `jobs/delete.ts` 用的：删目录必须和 `updateJob` 的「读 → 写盘 → 更索引」互斥，
 * 否则 rm 落在读与写之间时 `updateJob` 的 `mkdir` 会把刚删掉的目录连同 job.json 一起复活。
 * 反过来让 `store.ts` 去 import `delete.ts` 会成环（delete 要 `readJob` / `tmpDir`），
 * 所以共享的是锁，删除的实现只有 `delete.ts` 那一份。
 */
export async function withJobLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(id, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === current) locks.delete(id);
  }
}

export function toPublic(rec: JobRecord): JobPublic {
  const pub = {
    id: rec.id,
    status: rec.status,
    progress: clampProgress(rec.progress),
    mode: rec.mode,
    model: rec.model,
    provider: rec.provider,
    // 界面显示的是产品名（「标准」），不是 `model`（`kling-2.6`）。
    product: rec.product,
    productName: rec.productName,
    prompt: rec.prompt,
    durationSec: rec.durationSec,
    aspectRatio: rec.aspectRatio,
    resolution: rec.resolution,
    generateAudio: rec.generateAudio,
    lastFrameStored: rec.lastFrameStored,
    // 老记录没有这个字段（那时它是字面量 false），读出即 false——与当初的语义一致。
    lastFrameLocksOutput: Boolean(rec.lastFrameLocksOutput),
    harness: { enabled: Boolean(rec.harness?.enabled) },
    priceCny: rec.priceCny,
    costUsdEstimate: rec.costUsdEstimate,
    costUsdPlanned: rec.costUsdPlanned ?? null,
    costUsdActual: rec.costUsdActual,
    costIncomplete: Boolean(rec.costIncomplete),
    costOverTarget: Boolean(rec.costOverTarget),
    imageResolution: rec.imageResolution ?? null,
    // 标签之前的记录没有这个字段，读出即空数组——公开形状上它恒定是数组。
    tags: rec.tags ?? [],
    error: rec.error,
    output: coerceOutput(rec.output),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    artifactsPurgedAt: rec.artifactsPurgedAt ?? null,
    bible: null,
    retryBlocked: retryBlock(rec),
    shots: publicShots(rec),
  };
  return jobPublicSchema.parse(pub);
}

function publicShots(rec: JobRecord): JobPublic["shots"] {
  if (!rec.harnessPlan || !rec.harnessShots) return null;
  const durations = new Map(rec.harnessPlan.shots.map((s) => [s.id, s.durationSec]));
  return rec.harnessShots
    .map((s) => ({
      id: s.id,
      index: s.index,
      durationSec: durations.get(s.id) ?? 0,
      status: s.status,
      retries: s.retries,
      error: s.error ?? null,
    }))
    .sort((a, b) => a.index - b.index);
}

function coerceOutput(raw: JobRecord["output"] | { videoUrl?: string; posterUrl?: string; durationSec?: number; imageUrl?: string; kind?: string } | null): JobPublic["output"] {
  if (!raw) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "image" && typeof o.imageUrl === "string") {
    return { kind: "image", imageUrl: o.imageUrl };
  }
  if (typeof o.imageUrl === "string" && !o.videoUrl) {
    return { kind: "image", imageUrl: o.imageUrl };
  }
  if (typeof o.videoUrl === "string") {
    return {
      kind: "video",
      videoUrl: o.videoUrl,
      posterUrl: typeof o.posterUrl === "string" ? o.posterUrl : "",
      durationSec: typeof o.durationSec === "number" ? o.durationSec : 0,
    };
  }
  return null;
}

export async function writeJob(rec: JobRecord): Promise<JobRecord> {
  return withJobLock(rec.id, async () => {
    rec.updatedAt = new Date().toISOString();
    const dir = mediaStore.jobDir(rec.id);
    await mkdir(dir, { recursive: true });
    await writeJobJson(dir, rec);
    // 写序固定：事实源先落盘，派生索引后更新（`jobs/index.ts` 的纪律 2）。
    await upsertJobIndex(rec);
    return rec;
  });
}

export async function readJob(id: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(path.join(mediaStore.jobDir(id), "job.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export async function updateJob(
  id: string,
  fn: (rec: JobRecord) => JobRecord | Promise<JobRecord>,
): Promise<JobRecord> {
  return withJobLock(id, async () => {
    const rec = await readJobUnlocked(id);
    if (!rec) throw new Error("job not found");
    const before = rec.status;
    const next = await fn(rec);
    stampCompletedAt(before, next);
    // 先扣钱、成功了才盖 `chargedAt` 并落盘。
    //
    // 崩溃语义：预留（`loadBalanceUsage` 数非终态任务的 priceCny）与真扣款之间不能
    // 有真空。反过来写（先落盘终态、再扣款）就会开一个窗口：磁盘上任务已经终态，
    // 准入看不见预留了，钱又还没减，并发的下一单能超发。现在的顺序保证任一时刻要么
    // 任务还是非终态（预留占着钱），要么余额已经减了。
    //
    // 代价是「扣了钱、写盘前崩」这一种：磁盘上任务仍是非终态，重启 recover 把它推到
    // 终态时会再走一遍这里，但 `applyBalanceChange` 对同 jobId 的 charge 幂等
    // （流水里已有那一行），第二次直接返回，不会重复扣。
    //
    // 扣款抛错时仍然落终态——任务不能卡在「明明出片了却显示进行中」——只是不盖
    // `chargedAt`，日志里带 jobId；下一次任何 `updateJob` 命中「succeeded 且没有
    // chargedAt」会再试一次补扣（`pendingCharge` 因此不看终态边沿），幂等保证补扣
    // 不会变成重复扣。
    const charge = pendingCharge(next);
    if (charge && (await settleCharge(charge))) {
      next.billing = { chargedAt: new Date().toISOString() };
    }
    // 与扣款对称的释放路径（A 包）：非成功终态任务的会员 earmark 要有个了结——
    // 当期 earmark 溶解回可花池（不写流水），过期 earmark 写一行冲销把它清出池子。
    await settleRelease(next);
    next.updatedAt = new Date().toISOString();
    const dir = mediaStore.jobDir(id);
    await mkdir(dir, { recursive: true });
    await writeJobJson(dir, next);
    await upsertJobIndex(next);
    return next;
  });
}

/**
 * 删除任务的实现只有一份，在 `@/lib/jobs/delete.ts`（`deleteJobById`）：这里曾经有一个
 * 不清 `data/tmp/` 暂存文件、也不复核状态的 `deleteJob`，两份实现分头维护正是这条路径
 * 出问题的原因。它现在通过 `withJobLock` 与本文件的写路径互斥。
 */

type Charge = { jobId: string; ownerId: string; priceCny: number; memberMaxCny?: number };

/**
 * 「这条记录此刻该不该扣钱」的纯判定，不改 `next`（`chargedAt` 由 `updateJob` 在扣款
 * 成功之后才盖）。扣款只在 `updateJob` 这一处发生（方案 §3.2）。
 *
 * 四个条件缺一不可：结果是成功、这条任务有价、有主、且还没扣过。失败 / 取消 / 过期
 * 不扣钱——预留随终态自然释放，「上游挂了不该用户掏钱」。
 *
 * 刻意**不**要求「非终态 → 终态的那一次边沿」：上一轮扣款抛错时任务已经写成终态、
 * 却没有 `chargedAt`，补扣就得靠后续任意一次 `updateJob` 再命中这里。重复扣的风险由
 * `applyBalanceChange` 的同 jobId 幂等兜住，不需要边沿来兼任去重。
 */
function pendingCharge(next: JobRecord): Charge | null {
  if (next.status !== "succeeded") return null;
  if (next.billing?.chargedAt) return null;
  const priceCny = typeof next.priceCny === "number" && Number.isFinite(next.priceCny) ? next.priceCny : 0;
  if (priceCny <= 0 || !next.ownerId) return null;
  return {
    jobId: next.id,
    ownerId: next.ownerId,
    priceCny,
    // 准入时冻结的会员 earmark 封顶这次扣款的会员份额（A 包）：不许把别的在途任务
    // earmark 进池的钱花在这条任务上。老任务没有预留对象，沿用会员池优先的旧语义。
    memberMaxCny: next.reservation?.memberCny,
  };
}

/**
 * 扣款失败只记日志，不回滚任务，也不把成片藏起来：钱的事故（少收一次）比任务卡在
 * 「明明出片了却显示失败」便宜得多。日志里带 jobId 与金额，对账时能补，下一次
 * `updateJob` 也会自动再试。返回是否真的扣成了，调用方据此决定盖不盖 `chargedAt`。
 */
async function settleCharge(charge: Charge): Promise<boolean> {
  try {
    await applyBalanceChange(
      charge.ownerId,
      -charge.priceCny,
      {
        kind: "charge",
        amountCny: -charge.priceCny,
        jobId: charge.jobId,
      },
      charge.memberMaxCny !== undefined ? { memberMaxCny: charge.memberMaxCny } : {},
    );
    return true;
  } catch (error) {
    log("error", "余额扣款失败，任务照常完成，下次 updateJob 会补扣，请按 jobId 人工对账", {
      jobId: charge.jobId,
      ownerId: charge.ownerId,
      priceCny: charge.priceCny,
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 非成功终态任务的会员 earmark 了结（A 包）。
 *
 * 三种情形：
 *
 *  - earmark 还在当期（订阅没换、期次没滚）：钱本来还是有效会员积分，直接「溶解」
 *    回可花池——不写流水，只盖 `releasedAt`；
 *  - earmark 已过期（换订阅 / 跨期 / 订阅没了）且还在池里：写一行 `res:<id>:release`
 *    的 `adjust` 冲销——过期会员额就此作废，不转成已购余额；
 *  - earmark 已过期但已被整池扣减（期次重置 / 到期清零）一并清掉：任务终态之后才
 *    发生的那次扣减天然包含了它，再冲会把本期新发的积分误扣一份——只盖戳不写行。
 *    「终态之后才扣减」的判据：最近一次会员池整池扣减的时刻 > `completedAt`。
 *
 * 与 `settleCharge` 同一模式：抛错不挡终态落盘，不盖 `releasedAt`，下一次任何
 * `updateJob` 命中同一条件自动补偿；`res:<id>:release` 这条 ref 让补偿天然幂等。
 */
async function settleRelease(rec: JobRecord): Promise<void> {
  const res = rec.reservation;
  if (!res || res.releasedAt || !(res.memberCny > 0) || !rec.ownerId) return;
  if (!isTerminalStatus(rec.status) || rec.status === "succeeded") return;
  try {
    const user = await readUser(rec.ownerId);
    const sub = user?.subscription;
    const stillCurrent = Boolean(
      user &&
        subscriptionActive(user) &&
        sub &&
        sub.id === res.subscriptionId &&
        sub.periodIndex === res.periodIndex,
    );
    if (!stillCurrent) {
      const lastDebit = await latestMemberDebitAt(rec.ownerId);
      const absorbedByReset = Boolean(lastDebit && rec.completedAt && lastDebit > rec.completedAt);
      if (!absorbedByReset) {
        await applyBalanceChange(
          rec.ownerId,
          -res.memberCny,
          {
            kind: "adjust",
            amountCny: -res.memberCny,
            ref: `res:${res.id}:release`,
            note: "会员积分预留过期冲销",
          },
          { pool: "member" },
        );
      }
    }
    res.releasedAt = new Date().toISOString();
  } catch (error) {
    log("error", "earmark 冲销失败，任务照常落终态，下次 updateJob 会补偿", {
      jobId: rec.id,
      ownerId: rec.ownerId,
      reservationId: res.id,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The one place a job gets its `completedAt`.
 *
 * Every terminal transition in the codebase goes through `updateJob` (`writeJob`
 * only ever creates or re-queues a record), so stamping here — rather than at
 * each `fail` / `succeed` / cancel call site — is what makes the field
 * exhaustive: a new terminal path cannot forget it.
 *
 * Two guards keep the stamp meaningful as a *settle day* for the quota:
 *  - it is only written on the non-terminal → terminal edge, so a later write on
 *    an already-finished job (an artifact sweep, a cost correction) cannot move
 *    the job into today;
 *  - an existing value is never overwritten, for the same reason.
 */
function stampCompletedAt(before: JobRecord["status"], next: JobRecord): void {
  if (next.completedAt) return;
  if (isTerminalStatus(before) || !isTerminalStatus(next.status)) return;
  next.completedAt = new Date().toISOString();
}

async function writeJobJson(dir: string, record: JobRecord): Promise<void> {
  // Temporary file + atomic rename, with the Windows retry — see
  // `@/lib/storage/atomic-json`, which the user store shares.
  await writeJsonAtomic(path.join(dir, "job.json"), record);
}

async function readJobUnlocked(id: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(path.join(mediaStore.jobDir(id), "job.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

/**
 * 全量读盘：`data/jobs/*​/job.json` 一份不落。
 *
 * **新代码不要用它。** 随历史任务数线性恶化正是方案 §3.3 要消灭的东西；筛选走
 * `listJobIndex()`（一次 `readdir` + 进程内映射），再按 id 读回需要的那几份记录。
 * 现在只剩启动时的 `recover()` 用它——那一次确实需要每条记录的完整内容，且只跑一次。
 */
export async function listJobRecords(): Promise<JobRecord[]> {
  const ids = await mediaStore.listJobs();
  const out: JobRecord[] = [];
  for (const id of ids) {
    const rec = await readJob(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * `readJob` with the visibility rule applied. A job the caller may not see must
 * be indistinguishable from one that does not exist (plan §5.1: 404, never 403,
 * so job ids cannot be probed), which is why every route funnels through here
 * instead of comparing `ownerId` itself.
 */
export async function readJobForUser(id: string, userId: string): Promise<JobRecord | null> {
  const rec = await readJob(id);
  return rec && canAccessJob(rec, userId) ? rec : null;
}

/** The list one user is allowed to see (plan §5.1). 同样是全量读盘，见 `listJobRecords`。 */
export async function listJobRecordsForUser(userId: string): Promise<JobRecord[]> {
  const recs = await listJobRecords();
  return recs.filter((rec) => canAccessJob(rec, userId));
}

/**
 * 按 id 读回一页记录（配 `listJobIndex` 用）。读不到的（目录被手工删了、记录半写）
 * 直接跳过，而不是让整页塌掉——索引是缓存，落后一步是它被允许的状态。
 *
 * 顺序照传进来的 id 顺序，调用方已经排过序了。
 */
export async function readJobsByIds(ids: readonly string[]): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  for (const id of ids) {
    const rec = await readJob(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function tmpDir() {
  return path.join(dataDir(), "tmp");
}

export function idempotencyDir() {
  return path.join(dataDir(), "idempotency");
}
