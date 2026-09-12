import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { isTerminalStatus, nativeModeSchema, type JobRecord } from "@/lib/jobs/schema";
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

/** 终态子集：item.status 只允许这四个值。 */
const terminalStatusSchema = z.enum(["succeeded", "failed", "canceled", "expired"]);
export type NotificationStatus = z.infer<typeof terminalStatusSchema>;

const notificationItemSchema = z.object({
  seq: z.number().int().min(1),
  /** `${jobId}:${status}` —— 同一次完成只入一次（幂等键）。 */
  id: z.string().min(1),
  kind: z.literal("job"),
  jobId: z.string().min(1),
  status: terminalStatusSchema,
  mode: nativeModeSchema,
  prompt: z.string(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  at: z.string(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

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
async function loadOrRebuild(ownerId: string): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(notificationPath(ownerId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log("warn", "通知文件不存在，以新 epoch 重建空文件", { ownerId });
    const file = emptyFile(ownerId);
    await writeJsonAtomic(notificationPath(ownerId), file);
    return { kind: "ok", file };
  }
  const parsed = notificationFileSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    log("warn", "通知文件损坏，以新 epoch 重建空文件", { ownerId });
    const file = emptyFile(ownerId);
    await writeJsonAtomic(notificationPath(ownerId), file);
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

/**
 * `updateJob` 的终态边沿调用（唯一写入点）：把一条「非终态 → 终态」的任务落成
 * 一条通知。幂等键是 `${jobId}:${status}`——崩溃恢复把同一终态再推一遍时不会重复入。
 *
 * 非终态 / 无主任务直接返回（`updateJob` 在调用处已判过边沿与 ownerId，这里是
 * 第二道防线，让「忘记判」的调用方也不会写出半成品通知）。
 */
export async function appendJobNotification(job: JobRecord): Promise<NotificationFile | null> {
  if (!job.ownerId || !isTerminalStatus(job.status)) return null;
  const ownerId = job.ownerId;
  return withNotificationLock(ownerId, async () => {
    const loaded = await loadOrRebuild(ownerId);
    // 文件记的不是这个人：内容不可信，按损坏处理——换新 epoch 重建再追加。
    const file = loaded.kind === "ok" ? loaded.file : emptyFile(ownerId);
    const id = `${job.id}:${job.status}`;
    if (file.items.some((i) => i.id === id)) return file;
    const item: NotificationItem = {
      seq: file.nextSeq,
      id,
      kind: "job",
      jobId: job.id,
      status: job.status as NotificationStatus,
      mode: job.mode,
      prompt: [...job.prompt].slice(0, PROMPT_MAX_CHARS).join(""),
      ...(job.error
        ? { errorCode: job.error.code, errorMessage: job.error.message }
        : {}),
      at: job.completedAt ?? job.updatedAt,
    };
    file.nextSeq += 1;
    file.items.push(item);
    if (file.items.length > MAX_NOTIFICATIONS) {
      file.items = file.items.slice(file.items.length - MAX_NOTIFICATIONS);
    }
    return writeFile(file);
  });
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
