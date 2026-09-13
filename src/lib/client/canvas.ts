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
  assetId?: string;
  assetExpiresAt?: string;
  assetState?: "ready" | "missing" | "expired";
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

/* ---------- D 包：整图运行（CanvasRun） ---------- */

export type CanvasNodeExecStatus =
  | "waiting_dependencies"
  | "ready"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";

export type CanvasRunStatus = "running" | "succeeded" | "partially_failed" | "failed" | "canceled";

/**
 * 审批门超时（2026-09-13 产品拍板 24h）：镜像 `dag.ts` 的 APPROVAL_TIMEOUT_MS。
 * 服务端模块进不了客户端组件（env/log/fs 依赖），这里保留同名同值镜像。
 */
export const CANVAS_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type CanvasNodeExecution = {
  nodeId: string;
  attempt: number;
  status: CanvasNodeExecStatus;
  jobId?: string;
  errorCode?: string;
  /** 本执行位复用了上一次 run 的成功产物（不新建任务、不计费）。 */
  reused?: boolean;
  /** 人工门的决策记录。 */
  approval?: { decision: "approved" | "rejected"; decidedAt: string };
  /** 第一次进入 `awaiting_approval` 的时刻；+24h 后服务端收敛成 blocked/approval_timeout。 */
  awaitingSince?: string;
  /** 第一次撞 `queue_full` 的时刻；+1h 后收敛成 blocked/queue_timeout。 */
  queueWaitSince?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type CanvasQuoteItem = {
  nodeId: string;
  kind: CanvasNodeKind;
  mode: "text_to_image" | "text_to_video" | "image_to_video";
  priceCny: number;
  productName?: string;
  summary: string;
  /** 复用上一次 run 的成功产物：本次不执行、不计费。 */
  reused?: boolean;
  /** 复用时指向被采纳的历史任务。 */
  adoptedJobId?: string;
  /** 输入未变但历史产物已清理：本 run 里会 blocked，须 regenerate 显式重跑。 */
  purged?: boolean;
};

export type CanvasQuote = {
  hash: string;
  totalCny: number;
  reusedCount?: number;
  items: CanvasQuoteItem[];
};

export type CanvasRun = {
  id: string;
  canvasId: string;
  status: CanvasRunStatus;
  cancelRequestedAt?: string;
  quote: CanvasQuote;
  /** 执行前需人工批准的节点。 */
  gatedNodeIds?: string[];
  nodeExecutions: CanvasNodeExecution[];
  createdAt: string;
  finishedAt?: string;
};

/** 整图报价：逐节点明细 + 总价 + `hash`（建 run 时回传，图变即 `quote_stale`）。 */
export async function quoteCanvas(canvasId: string, regenerate?: string[]): Promise<CanvasQuote> {
  const res = await fetch(`/api/canvases/${canvasId}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(regenerate?.length ? { regenerate } : {}),
  });
  const data = await parseAuthed<{ quote?: CanvasQuote }>(res, "报价失败");
  if (!data.quote) throw new Error("报价失败");
  return data.quote;
}

export async function createCanvasRunApi(input: {
  canvasId: string;
  quoteHash: string;
  idempotencyKey: string;
  approvalNodeIds?: string[];
  regenerate?: string[];
}): Promise<CanvasRun> {
  const res = await fetch("/api/canvas-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseAuthed<{ run?: CanvasRun }>(res, "运行失败");
  if (!data.run) throw new Error("运行失败");
  return data.run;
}

export async function fetchCanvasRun(runId: string): Promise<CanvasRun | null> {
  const res = await fetch(`/api/canvas-runs/${runId}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const data = await parseAuthed<{ run?: CanvasRun }>(res, "无法读取运行状态");
  return data.run ?? null;
}

export async function fetchCanvasRuns(canvasId: string): Promise<CanvasRun[]> {
  const res = await fetch(`/api/canvases/${canvasId}/runs`, { cache: "no-store" });
  const data = await parseAuthed<{ runs?: CanvasRun[] }>(res, "无法读取运行列表");
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function cancelCanvasRunApi(runId: string): Promise<CanvasRun> {
  const res = await fetch(`/api/canvas-runs/${runId}/cancel`, { method: "POST" });
  const data = await parseAuthed<{ run?: CanvasRun }>(res, "取消失败");
  if (!data.run) throw new Error("取消失败");
  return data.run;
}

/** 审批门：批准 → 节点继续提交；驳回 → 该节点 blocked 并传播下游。 */
export async function decideCanvasRunApprovalApi(
  runId: string,
  nodeId: string,
  decision: "approve" | "reject",
): Promise<CanvasRun> {
  const res = await fetch(`/api/canvas-runs/${runId}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, decision }),
  });
  const data = await parseAuthed<{ run?: CanvasRun }>(res, "审批失败");
  if (!data.run) throw new Error("审批失败");
  return data.run;
}
