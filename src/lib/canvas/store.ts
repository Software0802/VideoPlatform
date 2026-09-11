import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { ProviderHttpError } from "@/lib/providers/types";
import { assertUserId } from "@/lib/users/store";
import {
  CANVAS_ID_RE,
  canvasDocSchema,
  type CanvasDocument,
  type CanvasPatchBody,
} from "@/lib/canvas/schema";

/**
 * 画布存储：`data/canvases/<userId>/<canvasId>.json`（C 包）。
 *
 * 形状照抄 `agent/store.ts`：路径里带 ownerId 让越权在拼路径这一步就不可能；
 * 读回再核一次 `ownerId`，手改过的文件也出不去。revision 是整篇文档的乐观并发
 * 戳——PATCH 带 `expectedRevision`，对不上就 409 `revision_conflict`，两个标签页
 * 不会互相静默覆盖。
 */

export function canvasDir(): string {
  return path.join(dataDir(), "canvases");
}

export function canvasUserDir(ownerId: string): string {
  assertUserId(ownerId);
  return path.join(canvasDir(), ownerId);
}

export function canvasPath(ownerId: string, canvasId: string): string {
  if (!CANVAS_ID_RE.test(canvasId)) throw new Error("invalid canvas id");
  return path.join(canvasUserDir(ownerId), `${canvasId}.json`);
}

export function newCanvasId(): string {
  return `cv_${randomBytes(6).toString("hex")}`;
}

export function newCanvasNodeId(): string {
  return `n_${randomBytes(4).toString("hex")}`;
}

export function newCanvasEdgeId(): string {
  return `e_${randomBytes(4).toString("hex")}`;
}

type GlobalLockState = typeof globalThis & { __lumenCanvasLockTail?: Promise<void> };
const globalLockState = globalThis as GlobalLockState;

/** 画布文件的读-改-写串行锁，与 agent / users 同形。 */
async function withCanvasLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLockState.__lumenCanvasLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLockState.__lumenCanvasLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 非本人、不存在、坏文件一律 `null`——调用方渲染成 404，与任务同一条纪律。 */
export async function readCanvas(ownerId: string, canvasId: string): Promise<CanvasDocument | null> {
  if (!CANVAS_ID_RE.test(canvasId)) return null;
  let raw: string;
  try {
    raw = await readFile(canvasPath(ownerId, canvasId), "utf8");
  } catch {
    return null;
  }
  const parsed = canvasDocSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    log("warn", "画布文件无法解析", { canvasId, ownerId });
    return null;
  }
  if (parsed.data.ownerId !== ownerId) return null;
  return parsed.data;
}

/** 原子写：先临时文件再 rename。 */
export async function writeCanvas(doc: CanvasDocument): Promise<CanvasDocument> {
  const file = canvasPath(doc.ownerId, doc.id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await rename(tmp, file);
  return doc;
}

export async function listCanvases(ownerId: string): Promise<{ id: string; title: string; updatedAt: string }[]> {
  let names: string[];
  try {
    names = await readdir(canvasUserDir(ownerId));
  } catch {
    return [];
  }
  const docs = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .filter((id) => CANVAS_ID_RE.test(id))
      .map((id) => readCanvas(ownerId, id)),
  );
  return docs
    .filter((d): d is CanvasDocument => d !== null)
    .map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function createCanvas(ownerId: string, title = "未命名画布"): Promise<CanvasDocument> {
  return withCanvasLock(async () => {
    const now = new Date().toISOString();
    return writeCanvas({
      schemaVersion: 1,
      id: newCanvasId(),
      ownerId,
      title,
      revision: 0,
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * 乐观并发写（C 包硬要求）：`expectedRevision` 对不上当前 revision 就 409——
 * 两个标签页各拿各的底稿，慢的那一边不会把快的覆盖掉。冲突方拿到最新文档
 * 由调用方（GET 详情）决定怎么合。
 */
export async function patchCanvas(
  ownerId: string,
  canvasId: string,
  patch: CanvasPatchBody,
): Promise<CanvasDocument | null> {
  return withCanvasLock(async () => {
    const current = await readCanvas(ownerId, canvasId);
    if (!current) return null;
    if (patch.expectedRevision !== current.revision) {
      throw new ProviderHttpError(
        409,
        "revision_conflict",
        `画布已被别处修改（当前 revision ${current.revision}），请刷新后再改`,
      );
    }
    return writeCanvas({
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.nodes !== undefined ? { nodes: patch.nodes } : {}),
      ...(patch.edges !== undefined ? { edges: patch.edges } : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
  });
}

/** 通用读-改-写（run 路由把 jobId 写回节点用）：`fn` 返回空 = 不改。 */
export async function updateCanvas(
  ownerId: string,
  canvasId: string,
  fn: (d: CanvasDocument) => CanvasDocument | null | undefined,
): Promise<CanvasDocument | null> {
  return withCanvasLock(async () => {
    const current = await readCanvas(ownerId, canvasId);
    if (!current) return null;
    const next = fn(current);
    if (!next) return current;
    return writeCanvas({ ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() });
  });
}

export async function deleteCanvas(ownerId: string, canvasId: string): Promise<boolean> {
  return withCanvasLock(async () => {
    const current = await readCanvas(ownerId, canvasId);
    if (!current) return false;
    await rm(canvasPath(ownerId, canvasId), { force: true });
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
