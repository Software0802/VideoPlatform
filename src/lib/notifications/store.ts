import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { readCanvas } from "@/lib/canvas/store";
import type { CanvasRun } from "@/lib/canvas/schema";
import type { AgentSession } from "@/lib/agent/schema";
import { isTerminalStatus, nativeModeSchema, type JobRecord } from "@/lib/jobs/schema";
import { emitNotification } from "@/lib/notifications/events";
import { ProviderHttpError } from "@/lib/providers/types";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import { USER_ID_RE } from "@/lib/users/schema";
import { assertUserId } from "@/lib/users/store";

/*
  通知落盘（H 包 §2）：`data/notifications/<userId>.json`，一个用户一份文件。

  形状 `{ schemaVersion, ownerId, epoch, nextSeq, lastReadSeq, items }`：
   - `epoch` 是这份存储的代际：文件损坏 / 重建时换新值，旧客户端手里的 seq 游标
     随之作废（`markRead` 对不上的 epoch 一律 409，客户端重拉 GET）；
   - `items` 按 `seq` 递增追加、只保留最近 `MAX_NOTIFICATIONS` 条（从头截断）；
   - 通知是**展示数据**不是资金：坏文件记 warn 重建，不 fail closed。

  每用户一把内存串行锁（与 `withJobLock` 同形，按 userId 分桶挂在 globalThis），
  读-改-写都在锁内；它与 admission / user / job 锁没有交集，不参与既有锁序。
*/

/** 单用户最多保留的通知条数；也是 `GET /api/notifications` 的全量上限。 */
export const MAX_NOTIFICATIONS = 200;

/** 通知正文摘要的最大字数（按码点截，与 `tagLength` 同口径）。 */
const PROMPT_MAX_CHARS = 120;

/** job 通知沿用的终态子集。 */
const terminalStatusSchema = z.enum(["succeeded", "failed", "canceled", "expired"]);
export type NotificationStatus = z.infer<typeof terminalStatusSchema>;

const itemBase = {
  seq: z.number().int().min(1),
  id: z.string().min(1),
  at: z.string(),
};

const jobNotificationItemSchema = z.object({
  ...itemBase,
  kind: z.literal("job"),
  jobId: z.string().min(1),
  status: terminalStatusSchema,
  mode: nativeModeSchema,
  prompt: z.string(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

const runNotificationItemSchema = z.object({
  ...itemBase,
  kind: z.literal("run"),
  runId: z.string().min(1),
  canvasId: z.string().min(1),
  canvasTitle: z.string().optional(),
  status: z.enum(["succeeded", "partially_failed", "failed", "canceled", "awaiting_approval"]),
  nodeId: z.string().optional(),
  nodeCounts: z
    .object({
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
    })
    .optional(),
});

const agentNotificationItemSchema = z.object({
  ...itemBase,
  kind: z.literal("agent"),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  sessionTitle: z.string(),
  status: z.enum(["awaiting_approval", "failed"]),
  totalCny: z.number().optional(),
  actionCount: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

const notificationItemSchema = z.discriminatedUnion("kind", [
  jobNotificationItemSchema,
  runNotificationItemSchema,
  agentNotificationItemSchema,
]);
export type NotificationItem = z.infer<typeof notificationItemSchema>;
export type RunNotificationItem = z.infer<typeof runNotificationItemSchema>;
export type AgentNotificationItem = z.infer<typeof agentNotificationItemSchema>;
type NotificationItemInput = NotificationItem extends infer Item
  ? Item extends NotificationItem
    ? Omit<Item, "seq">
    : never
  : never;

const notificationFileSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(USER_ID_RE),
  epoch: z.string().min(1),
  /** 下一条要分配的 seq（从 1 起，同一 epoch 内单调递增）。 */
  nextSeq: z.number().int().min(1),
  /** 已读游标（含）：`seq > lastReadSeq` 的条数就是未读数。 */
  lastReadSeq: z.number().int().min(0),
  items: z.array(notificationItemSchema),
});
export type NotificationFile = z.infer<typeof notificationFileSchema>;

/** `GET /api/notifications` 与 `POST /api/notifications/read` 共用的响应形状。 */
export type NotificationPayload = {
  epoch: string;
  /** 全量、按 seq 倒序（最新在前）。 */
  items: NotificationItem[];
  lastReadSeq: number;
  /** 服务端算的未读数（`seq > lastReadSeq`），客户端不自己数。 */
  unread: number;
};

export function notificationsDir(): string {
  return path.join(dataDir(), "notifications");
}

export function notificationPath(ownerId: string): string {
  assertUserId(ownerId);
  return path.join(notificationsDir(), `${ownerId}.json`);
}

/** 存储代际 id，与 `usr_` / `crun_` 同一套 `randomBytes` 习惯。 */
function newNotificationEpoch(): string {
  return `nep_${randomBytes(8).toString("hex")}`;
}

type GlobalLockState = typeof globalThis & {
  __lumenNotificationLocks?: Map<string, Promise<void>>;
};
const globalLockState = globalThis as GlobalLockState;
const locks =
  globalLockState.__lumenNotificationLocks ?? (globalLockState.__lumenNotificationLocks = new Map());

/** 一个用户一条串行队列（tail-promise，键是 userId）。形状照抄 `withJobLock`。 */
async function withNotificationLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(ownerId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(ownerId, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(ownerId) === current) locks.delete(ownerId);
  }
}

function emptyFile(ownerId: string): NotificationFile {
  return {
    schemaVersion: 1,
    ownerId,
    epoch: newNotificationEpoch(),
    nextSeq: 1,
    lastReadSeq: 0,
    items: [],
  };
}

type LoadResult =
  | { kind: "ok"; file: NotificationFile }
  /** 路径里的 ownerId 与文件里记的对不上——路由层翻译成 404。 */
  | { kind: "mismatch" };

/**
  读出通知文件；不存在 / 损坏时**就地重建**一份新 epoch 的空文件并照常返回
  （通知不是资金，不 fail closed——代价只是客户端手里的游标作废，重拉一次就好）。
*/
async function loadOrRebuild(ownerId: string, persistRebuild = true): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(notificationPath(ownerId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log("warn", "通知文件不存在，以新 epoch 重建空文件", { ownerId });
    const file = emptyFile(ownerId);
    if (persistRebuild) await writeJsonAtomic(notificationPath(ownerId), file);
    return { kind: "ok", file };
  }
  const parsed = notificationFileSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    log("warn", "通知文件损坏，以新 epoch 重建空文件", { ownerId });
    const file = emptyFile(ownerId);
    if (persistRebuild) await writeJsonAtomic(notificationPath(ownerId), file);
    return { kind: "ok", file };
  }
  if (parsed.data.ownerId !== ownerId) return { kind: "mismatch" };
  return { kind: "ok", file: parsed.data };
}

async function writeFile(file: NotificationFile): Promise<NotificationFile> {
  await writeJsonAtomic(notificationPath(file.ownerId), file);
  return file;
}

/**
 * `GET /api/notifications` 的读取端。非本人（ownerId 对不上）返回 `null`，
 * 由路由渲染成 404——与任务 / 画布的「认不出 = 不存在」同一条纪律。
 */
export async function readNotifications(ownerId: string): Promise<NotificationFile | null> {
  assertUserId(ownerId);
  return withNotificationLock(ownerId, async () => {
    const loaded = await loadOrRebuild(ownerId);
    return loaded.kind === "ok" ? loaded.file : null;
  });
}

async function appendItems(
  ownerId: string,
  items: NotificationItemInput[],
): Promise<NotificationFile | null> {
  if (!items.length) return null;
  assertUserId(ownerId);
  return withNotificationLock(ownerId, async () => {
    const loaded = await loadOrRebuild(ownerId, false);
    // 文件记的不是这个人：内容不可信，按损坏处理——换新 epoch 重建再追加。
    const file = loaded.kind === "ok" ? loaded.file : emptyFile(ownerId);
    const known = new Set(file.items.map((item) => item.id));
    let added = 0;
    for (const item of items) {
      if (known.has(item.id)) continue;
      file.items.push({ ...item, seq: file.nextSeq } as NotificationItem);
      file.nextSeq += 1;
      known.add(item.id);
      added += 1;
    }
    if (!added) return file;
    if (file.items.length > MAX_NOTIFICATIONS) {
      file.items = file.items.slice(file.items.length - MAX_NOTIFICATIONS);
    }
    const written = await writeFile(file);
    emitNotification(ownerId);
    return written;
  });
}

/**
 * `updateJob` 的终态边沿调用（唯一写入点）：构造 job 项后交给 `appendItems` 批量路径。
 * 幂等键仍是 `${jobId}:${status}`，崩溃恢复重推同一终态不会重复入队。
 * 非终态 / 无主任务直接返回——调用处已经判过边沿，这里保留第二道防线。
 */
export async function appendJobNotification(job: JobRecord): Promise<NotificationFile | null> {
  if (!job.ownerId || !isTerminalStatus(job.status)) return null;
  return appendItems(job.ownerId, [
    {
      id: `${job.id}:${job.status}`,
      kind: "job",
      jobId: job.id,
      status: job.status as NotificationStatus,
      mode: job.mode,
      prompt: [...job.prompt].slice(0, PROMPT_MAX_CHARS).join(""),
      ...(job.error ? { errorCode: job.error.code, errorMessage: job.error.message } : {}),
      at: job.completedAt ?? job.updatedAt,
    },
  ]);
}

export function runNotificationEdges(
  before: CanvasRun | null,
  after: CanvasRun,
): Omit<RunNotificationItem, "seq">[] {
  const items: Omit<RunNotificationItem, "seq">[] = [];
  if ((!before || before.status === "running") && after.status !== "running") {
    const nodeCounts = { succeeded: 0, failed: 0, blocked: 0 };
    for (const execution of after.nodeExecutions) {
      if (execution.status === "succeeded") nodeCounts.succeeded += 1;
      else if (execution.status === "failed") nodeCounts.failed += 1;
      else if (execution.status === "blocked") nodeCounts.blocked += 1;
    }
    items.push({
      id: `${after.id}:${after.status}`,
      kind: "run",
      runId: after.id,
      canvasId: after.canvasId,
      status: after.status,
      nodeCounts,
      at: after.finishedAt ?? after.updatedAt,
    });
  }
  if (after.status === "running" && !after.cancelRequestedAt) {
    const prior = new Map(before?.nodeExecutions.map((execution) => [execution.nodeId, execution.status]));
    for (const execution of after.nodeExecutions) {
      if (execution.status !== "awaiting_approval" || prior.get(execution.nodeId) === "awaiting_approval") {
        continue;
      }
      items.push({
        id: `${after.id}:${execution.nodeId}:awaiting_approval`,
        kind: "run",
        runId: after.id,
        canvasId: after.canvasId,
        status: "awaiting_approval",
        nodeId: execution.nodeId,
        at: after.updatedAt,
      });
    }
  }
  return items;
}

export async function appendRunNotifications(
  before: CanvasRun | null,
  after: CanvasRun,
): Promise<NotificationFile | null> {
  const edges = runNotificationEdges(before, after);
  if (!edges.length) return null;
  let canvasTitle: string | undefined;
  try {
    canvasTitle = (await readCanvas(after.ownerId, after.canvasId))?.title;
  } catch {
    canvasTitle = undefined;
  }
  return appendItems(
    after.ownerId,
    edges.map((item) => (canvasTitle ? { ...item, canvasTitle } : item)),
  );
}

export function agentNotificationEdges(
  before: AgentSession,
  after: AgentSession,
): Omit<AgentNotificationItem, "seq">[] {
  const prior = new Map((before.turns ?? []).map((turn) => [turn.id, turn.status]));
  const items: Omit<AgentNotificationItem, "seq">[] = [];
  for (const turn of after.turns ?? []) {
    if (turn.status !== "awaiting_approval" && turn.status !== "failed") continue;
    if (prior.get(turn.id) === turn.status) continue;
    items.push({
      id: `${turn.id}:${turn.status}`,
      kind: "agent",
      sessionId: after.id,
      turnId: turn.id,
      sessionTitle: after.title,
      status: turn.status,
      ...(turn.status === "awaiting_approval" && turn.proposal
        ? {
            totalCny: turn.proposal.totalCny,
            actionCount: turn.proposal.actions.length,
          }
        : {}),
      ...(turn.status === "failed" && turn.error
        ? { errorCode: turn.error.code, errorMessage: turn.error.message }
        : {}),
      at: turn.updatedAt,
    });
  }
  return items;
}

export async function appendAgentNotifications(
  before: AgentSession,
  after: AgentSession,
): Promise<NotificationFile | null> {
  return appendItems(after.ownerId, agentNotificationEdges(before, after));
}

/**
 * `POST /api/notifications/read` 的写入端：`epoch` 对不上当前代际抛
 * 409 `notifications_stale`（路由经 `jsonError` 翻译），客户端收到后重拉 GET、
 * 不重试 POST。游标只前进不回退：`max(lastReadSeq, min(upToSeq, nextSeq-1))`。
 */
export async function markRead(
  ownerId: string,
  epoch: string,
  upToSeq: number,
): Promise<NotificationFile> {
  assertUserId(ownerId);
  return withNotificationLock(ownerId, async () => {
    const loaded = await loadOrRebuild(ownerId);
    const file = loaded.kind === "ok" ? loaded.file : emptyFile(ownerId);
    if (file.epoch !== epoch) {
      throw new ProviderHttpError(409, "notifications_stale", "通知状态已变化，请重新同步");
    }
    const next = Math.max(file.lastReadSeq, Math.min(upToSeq, file.nextSeq - 1));
    if (next === file.lastReadSeq) return file;
    file.lastReadSeq = next;
    return writeFile(file);
  });
}

/** 路由共用的响应组装：items 倒序 + 服务端算未读数（方案 §2.3，全量不分页）。 */
export function notificationPayload(file: NotificationFile): NotificationPayload {
  return {
    epoch: file.epoch,
    items: [...file.items].sort((a, b) => b.seq - a.seq),
    lastReadSeq: file.lastReadSeq,
    unread: file.items.reduce((n, i) => n + (i.seq > file.lastReadSeq ? 1 : 0), 0),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
