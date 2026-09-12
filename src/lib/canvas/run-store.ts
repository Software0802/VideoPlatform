import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import {
  CANVAS_RUN_ID_RE,
  canvasRunSchema,
  type CanvasRun,
} from "@/lib/canvas/schema";
import type { JobReservation } from "@/lib/jobs/schema";
import { ProviderHttpError } from "@/lib/providers/types";
import { assertUserId } from "@/lib/users/store";

/**
 * 画布运行存储（D 包）：`data/canvas-runs/<userId>/<runId>.json`，一文件一 run。
 *
 * 形状照抄 `store.ts` / `agent/store.ts`：路径里带 ownerId 让越权在拼路径这一步
 * 就不可能；读回再核一次 `ownerId`。幂等键落在 run 文件自身（事实源）——重放
 * 按目录扫描找回，run 数量小，不建第二份索引。
 */

export function canvasRunsDir(): string {
  return path.join(dataDir(), "canvas-runs");
}

export function canvasRunsUserDir(ownerId: string): string {
  assertUserId(ownerId);
  return path.join(canvasRunsDir(), ownerId);
}

export function canvasRunPath(ownerId: string, runId: string): string {
  if (!CANVAS_RUN_ID_RE.test(runId)) throw new Error("invalid canvas run id");
  return path.join(canvasRunsUserDir(ownerId), `${runId}.json`);
}

export function newCanvasRunId(): string {
  return `crun_${randomBytes(6).toString("hex")}`;
}

type GlobalLockState = typeof globalThis & { __lumenCanvasRunLockTail?: Promise<void> };
const globalLockState = globalThis as GlobalLockState;

/** run 文件的读-改-写串行锁，与 canvas / agent / users 同形。 */
export async function withRunLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLockState.__lumenCanvasRunLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLockState.__lumenCanvasRunLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 非本人、不存在、坏文件一律 `null`——调用方渲染成 404，与任务/画布同一条纪律。 */
export async function readCanvasRun(ownerId: string, runId: string): Promise<CanvasRun | null> {
  if (!CANVAS_RUN_ID_RE.test(runId)) return null;
  let raw: string;
  try {
    raw = await readFile(canvasRunPath(ownerId, runId), "utf8");
  } catch {
    return null;
  }
  const parsed = canvasRunSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    log("warn", "画布运行文件无法解析", { runId, ownerId });
    return null;
  }
  if (parsed.data.ownerId !== ownerId) return null;
  return parsed.data;
}

/** 原子写：先临时文件再 rename。 */
export async function writeCanvasRun(run: CanvasRun): Promise<CanvasRun> {
  const file = canvasRunPath(run.ownerId, run.id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await rename(tmp, file);
  return run;
}

/** 该用户全部 run（新建在前）。调用方按 canvasId 再过滤。 */
export async function listCanvasRuns(ownerId: string): Promise<CanvasRun[]> {
  let names: string[];
  try {
    names = await readdir(canvasRunsUserDir(ownerId));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .filter((id) => CANVAS_RUN_ID_RE.test(id))
      .map((id) => readCanvasRun(ownerId, id)),
  );
  return runs
    .filter((r): r is CanvasRun => r !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * 泵用的全量扫描：所有用户的非终态 run。内测规模下「目录清单即索引」，
 * 不为它单独建文件。
 */
export async function listActiveCanvasRuns(): Promise<CanvasRun[]> {
  let ownerDirs: string[];
  try {
    ownerDirs = await readdir(canvasRunsDir());
  } catch {
    return [];
  }
  const out: CanvasRun[] = [];
  for (const ownerId of ownerDirs) {
    try {
      const runs = await listCanvasRuns(ownerId);
      out.push(...runs.filter((r) => r.status === "running"));
    } catch {
      continue; // 单个用户目录坏了不拖垮整轮扫描。
    }
  }
  return out;
}

/**
 * 通用读-改-写：`fn` 返回空 = 不改。`fn` 可以是异步的——sweep 在锁内刷新
 * 子任务状态、提交新节点（`createJob` 内部走 admission 锁，锁序 run → admission，
 * 没有反向路径）。
 */
export async function updateCanvasRun(
  ownerId: string,
  runId: string,
  fn: (r: CanvasRun) => CanvasRun | null | undefined | Promise<CanvasRun | null | undefined>,
): Promise<CanvasRun | null> {
  return withRunLock(async () => {
    const current = await readCanvasRun(ownerId, runId);
    if (!current) return null;
    const next = await fn(current);
    if (!next) return current;
    return writeCanvasRun({ ...next, updatedAt: new Date().toISOString() });
  });
}

/** 按幂等键找这个用户已建过的 run（同 key 重放交回、异参 409 由调用方判）。 */
export async function findRunByIdempotencyKey(
  ownerId: string,
  key: string,
): Promise<CanvasRun | null> {
  const runs = await listCanvasRuns(ownerId);
  return runs.find((r) => r.idempotency?.key === key) ?? null;
}

export async function deleteCanvasRun(ownerId: string, runId: string): Promise<boolean> {
  return withRunLock(async () => {
    const current = await readCanvasRun(ownerId, runId);
    if (!current) return false;
    await rm(canvasRunPath(ownerId, runId), { force: true });
    return true;
  });
}

/* ---------- D 切片二：run 级预算预留的资金口径 ---------- */

export type RunHeldFunds = {
  /** 尚未转移给任何子任务的余量（仍在 run 上占着）。 */
  remainingCny: number;
  remainingMemberCny: number;
  /**
   * 已转移、但份额锚定的 job 在索引里不存在的部分——job 没落盘就不能由
   * `job.reservation` 计，由 transfer 记录兜底：宁可多占不超卖。
   */
  transferCny: number;
  transferMemberCny: number;
};

/**
 * 资金口径的严格读：与列表用的容错读相反——目录不存在（ENOENT）算「没有 run」，
 * 目录其它 IO 错、文件损坏都抛 `billing_state_corrupt` 失败关闭。余额判定宁可
 * 挡住新预留，也不能把一笔真实占用静默漏掉。
 */
async function listCanvasRunsStrict(ownerId: string): Promise<CanvasRun[]> {
  let names: string[];
  try {
    names = await readdir(canvasRunsUserDir(ownerId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const runs: CanvasRun[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.slice(0, -".json".length);
    if (!CANVAS_RUN_ID_RE.test(id)) continue;
    let raw: string;
    try {
      raw = await readFile(canvasRunPath(ownerId, id), "utf8");
    } catch (e) {
      // readdir 到 readFile 之间文件没了（并发删除）= 这条 run 已消失，跳过；
      // 其它读错（权限等）必须失败关闭。
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const parsed = canvasRunSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      throw new ProviderHttpError(
        500,
        "billing_state_corrupt",
        `画布运行记录损坏，无法确认资金占用: ${id}`,
      );
    }
    if (parsed.data.ownerId === ownerId) runs.push(parsed.data);
  }
  return runs;
}

/**
 * 该用户非终态 run 当前占用的资金（D 切片二）。`jobEntries` 必须是该用户的
 * **全量**任务索引（不能只传非终态——transfer 份额是否还计占用，取决于锚定的
 * job 是否存在，终态 job 表示份额已结算/释放）。
 */
export async function runHeldFunds(
  ownerId: string,
  jobEntries: readonly { id: string }[],
): Promise<RunHeldFunds> {
  const jobIds = new Set(jobEntries.map((e) => e.id));
  let remainingCny = 0;
  let remainingMemberCny = 0;
  let transferCny = 0;
  let transferMemberCny = 0;
  for (const run of await listCanvasRunsStrict(ownerId)) {
    if (run.status !== "running" || !run.reservation) continue;
    remainingCny += run.reservation.remainingCny;
    remainingMemberCny += run.reservation.remainingMemberCny;
    for (const t of Object.values(run.reservation.transfers)) {
      if (jobIds.has(t.jobId)) continue;
      transferCny += t.amountCny;
      transferMemberCny += t.memberCny;
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    remainingCny: r2(remainingCny),
    remainingMemberCny: r2(remainingMemberCny),
    transferCny: r2(transferCny),
    transferMemberCny: r2(transferMemberCny),
  };
}

/**
 * 把 `priceCny` 的份额从 run 余量转移到子任务（返回给 `createJob` 的
 * `reserveFunds` 回调）。
 *
 * 不取任何锁：调用方已经持有 run 锁（sweep）与 admission 锁（createJob 临界
 * 区），这里只做一次原子读-改-写。`run` 是调用方手里的活对象——就地改并落盘，
 * sweep 终写时带的就是同一份预留状态。
 *
 * 幂等：`transfers[nodeId]` 已存在 ⇒ 复用记录的分池份额、jobId 换成最新一条
 * （覆盖崩溃留下的孤儿 id），份额绝不重复扣。金额对不上属内部错误——报价校验
 * 在更上游就拦了价变，走到这里份额必须等于快照价。
 */
export async function carveRunShare(
  run: CanvasRun,
  nodeId: string,
  priceCny: number,
  jobId: string,
): Promise<JobReservation | undefined> {
  const res = run.reservation;
  if (!res || !(priceCny > 0)) return undefined;
  const now = new Date().toISOString();
  const existing = res.transfers[nodeId];
  if (existing) {
    if (existing.amountCny !== priceCny) {
      throw new ProviderHttpError(
        500,
        "internal_error",
        "画布运行台账金额与成交价不一致",
      );
    }
    existing.jobId = jobId;
    await writeCanvasRun(run);
    return {
      id: `res_${randomBytes(8).toString("hex")}`,
      amountCny: existing.amountCny,
      memberCny: existing.memberCny,
      purchasedCny: existing.purchasedCny,
      ...(existing.subscriptionId ? { subscriptionId: existing.subscriptionId } : {}),
      ...(existing.periodIndex !== undefined ? { periodIndex: existing.periodIndex } : {}),
      createdAt: now,
    };
  }
  if (res.remainingCny + 1e-9 < priceCny) {
    throw new ProviderHttpError(500, "internal_error", "画布运行预留余额不足（台账异常）");
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const memberCny = r2(Math.min(priceCny, res.remainingMemberCny));
  const purchasedCny = r2(priceCny - memberCny);
  res.remainingCny = r2(res.remainingCny - priceCny);
  res.remainingMemberCny = r2(res.remainingMemberCny - memberCny);
  res.remainingPurchasedCny = r2(res.remainingPurchasedCny - purchasedCny);
  res.transfers[nodeId] = {
    amountCny: priceCny,
    memberCny,
    purchasedCny,
    jobId,
    ...(res.subscriptionId ? { subscriptionId: res.subscriptionId } : {}),
    ...(res.periodIndex !== undefined ? { periodIndex: res.periodIndex } : {}),
  };
  await writeCanvasRun(run);
  return {
    id: `res_${randomBytes(8).toString("hex")}`,
    amountCny: priceCny,
    memberCny,
    purchasedCny,
    ...(res.subscriptionId ? { subscriptionId: res.subscriptionId } : {}),
    ...(res.periodIndex !== undefined ? { periodIndex: res.periodIndex } : {}),
    createdAt: now,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
