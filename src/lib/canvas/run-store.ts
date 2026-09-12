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

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
