import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyBalanceChange } from "@/lib/billing/ledger";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import {
  clampProgress,
  isTerminalStatus,
  jobPublicSchema,
  type JobPublic,
  type JobRecord,
} from "@/lib/jobs/schema";
import { canAccessJob } from "@/lib/jobs/ownership";
import { retryBlock } from "@/lib/jobs/retry-guard";
import { mediaStore } from "@/lib/storage/local-fs";

type GlobalLockState = typeof globalThis & {
  __lumenJobLocks?: Map<string, Promise<void>>;
};

const globalLockState = globalThis as GlobalLockState;
const locks = globalLockState.__lumenJobLocks ?? (globalLockState.__lumenJobLocks = new Map());

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
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
  return withLock(rec.id, async () => {
    rec.updatedAt = new Date().toISOString();
    const dir = mediaStore.jobDir(rec.id);
    await mkdir(dir, { recursive: true });
    await writeJobJson(dir, rec);
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
  return withLock(id, async () => {
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
    next.updatedAt = new Date().toISOString();
    const dir = mediaStore.jobDir(id);
    await mkdir(dir, { recursive: true });
    await writeJobJson(dir, next);
    return next;
  });
}

type Charge = { jobId: string; ownerId: string; priceCny: number };

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
  return { jobId: next.id, ownerId: next.ownerId, priceCny };
}

/**
 * 扣款失败只记日志，不回滚任务，也不把成片藏起来：钱的事故（少收一次）比任务卡在
 * 「明明出片了却显示失败」便宜得多。日志里带 jobId 与金额，对账时能补，下一次
 * `updateJob` 也会自动再试。返回是否真的扣成了，调用方据此决定盖不盖 `chargedAt`。
 */
async function settleCharge(charge: Charge): Promise<boolean> {
  try {
    await applyBalanceChange(charge.ownerId, -charge.priceCny, {
      kind: "charge",
      amountCny: -charge.priceCny,
      jobId: charge.jobId,
    });
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

/** The list one user is allowed to see (plan §5.1). */
export async function listJobRecordsForUser(userId: string): Promise<JobRecord[]> {
  const recs = await listJobRecords();
  return recs.filter((rec) => canAccessJob(rec, userId));
}

export function tmpDir() {
  return path.join(dataDir(), "tmp");
}

export function idempotencyDir() {
  return path.join(dataDir(), "idempotency");
}
