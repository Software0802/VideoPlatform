import type { JobPublic } from "@/lib/jobs/schema";
import { parseAuthed } from "@/lib/client/http";

/**
 * `/api/canvases/*` 的浏览器侧入口（C 包）。与服务端 schema 同形的镜像类型，
 * 浏览器不 import 服务端模块。
 */

export type CanvasNodeKind = "text" | "material" | "gen_image" | "gen_video";

export type CanvasNode = {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  text?: string;
  prompt?: string;
  product?: string;
  uploadId?: string;
  jobId?: string;
  runSeq?: number;
};

export type CanvasEdge = { id: string; from: string; to: string };

export type CanvasDocument = {
  id: string;
  title: string;
  revision: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  createdAt: string;
  updatedAt: string;
};

export type CanvasSummary = { id: string; title: string; updatedAt: string };

export function newCanvasNodeId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `n_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function newCanvasEdgeId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `e_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function readDoc(raw: unknown): CanvasDocument {
  if (!raw || typeof raw !== "object") throw new Error("服务端返回的画布形状无法识别");
  const d = raw as Record<string, unknown>;
  return {
    id: String(d.id ?? ""),
    title: String(d.title ?? "未命名画布"),
    revision: typeof d.revision === "number" ? d.revision : 0,
    nodes: Array.isArray(d.nodes) ? (d.nodes as CanvasNode[]) : [],
    edges: Array.isArray(d.edges) ? (d.edges as CanvasEdge[]) : [],
    createdAt: String(d.createdAt ?? ""),
    updatedAt: String(d.updatedAt ?? ""),
  };
}

export async function fetchCanvases(): Promise<CanvasSummary[]> {
  const res = await fetch("/api/canvases", { cache: "no-store" });
  const data = await parseAuthed<{ canvases?: unknown }>(res, "无法读取画布列表");
  return Array.isArray(data.canvases) ? (data.canvases as CanvasSummary[]) : [];
}

export async function createCanvasApi(title?: string): Promise<CanvasDocument> {
  const res = await fetch("/api/canvases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
  const data = await parseAuthed<{ canvas?: unknown }>(res, "无法创建画布");
  return readDoc(data.canvas);
}

export async function fetchCanvas(id: string): Promise<CanvasDocument | null> {
  const res = await fetch(`/api/canvases/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const data = await parseAuthed<{ canvas?: unknown }>(res, "无法读取画布");
  return readDoc(data.canvas);
}

export class RevisionConflictError extends Error {
  readonly code = "revision_conflict";
}

/**
 * 乐观并发写（C 包）：`expectedRevision` 对不上就 409。调用方（画布视图）
 * 在冲突时重新拉最新文档再决定怎么合——绝不静默覆盖。
 */
export async function patchCanvas(
  id: string,
  body: { expectedRevision: number; title?: string; nodes?: CanvasNode[]; edges?: CanvasEdge[] },
): Promise<CanvasDocument> {
  const res = await fetch(`/api/canvases/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new RevisionConflictError("画布已被别处修改");
  const data = await parseAuthed<{ canvas?: unknown }>(res, "保存画布失败");
  return readDoc(data.canvas);
}

/** 运行一条生成节点：内部走 createJob，与创作页同一套计价与幂等。 */
export async function runCanvasNodeApi(
  canvasId: string,
  nodeId: string,
): Promise<{ canvas: CanvasDocument; job: JobPublic }> {
  const res = await fetch(`/api/canvases/${canvasId}/nodes/${nodeId}/run`, { method: "POST" });
  const data = await parseAuthed<{ canvas?: unknown; job?: JobPublic }>(res, "运行失败");
  return { canvas: readDoc(data.canvas), job: data.job as JobPublic };
}
