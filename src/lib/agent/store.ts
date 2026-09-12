import { randomBytes } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { ProviderHttpError } from "@/lib/providers/types";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import { assertUserId } from "@/lib/users/store";
import {
  AGENT_SESSION_ID_RE,
  MAX_SESSIONS_PER_USER,
  agentSessionSchema,
  type AgentMessage,
  type AgentSession,
  type AgentSessionSummary,
} from "@/lib/agent/schema";

/**
 * 会话存储：`data/agent/<userId>/<sessionId>.json`（方案 §1）。
 *
 * 按用户分目录不是为了好看，是为了让**越权变成不可能**而不是「记得判一下」：路径里
 * 就带着 ownerId，别人的会话根本拼不出路径；读回来还会再核一次 `ownerId`，手改过的
 * 文件也越不了权。对不上一律当作不存在（404），与任务那边同一条纪律
 * （`docs/plan-users-quota.md` §5.1）——「拒绝的理由」不该泄露这条 id 真实存在。
 *
 * 没有索引文件：一个人最多 200 个会话，列表就是 readdir + 逐个读，比维护一份会漂移的
 * 派生缓存可靠。任务那边之所以要索引，是因为它要扫的是**全站**。
 */

export function agentDir(): string {
  return path.join(dataDir(), "agent");
}

export function agentUserDir(ownerId: string): string {
  assertUserId(ownerId);
  return path.join(agentDir(), ownerId);
}

export function agentSessionPath(ownerId: string, sessionId: string): string {
  if (!AGENT_SESSION_ID_RE.test(sessionId)) throw new Error("invalid agent session id");
  return path.join(agentUserDir(ownerId), `${sessionId}.json`);
}

export function newSessionId(): string {
  return `ses_${randomBytes(8).toString("hex")}`;
}

export function newMessageId(): string {
  return `msg_${randomBytes(8).toString("hex")}`;
}

type GlobalLockState = typeof globalThis & { __lumenAgentLockTail?: Promise<void> };
const globalLockState = globalThis as GlobalLockState;

/**
 * 会话文件的读-改-写串行锁，形状照抄 `users/lock.ts`。
 *
 * 只包住「读出来、追加消息、写回去」这几毫秒，**不**包住整轮（LLM 调用要几秒，把它
 * 锁进来等于全站的智能体一次只能有一个人在说话）。代价是两个并发轮次的消息顺序由
 * 落盘先后决定，这正是我们想要的；丢消息才是不能接受的，而那正是这把锁挡住的。
 */
async function withAgentLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalLockState.__lumenAgentLockTail ?? Promise.resolve();
  let release!: () => void;
  globalLockState.__lumenAgentLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 读一个会话。非本人、不存在、坏文件一律 `null`——调用方把三者都渲染成 404。
 */
export async function readSession(ownerId: string, sessionId: string): Promise<AgentSession | null> {
  if (!AGENT_SESSION_ID_RE.test(sessionId)) return null;
  let raw: string;
  try {
    raw = await readFile(agentSessionPath(ownerId, sessionId), "utf8");
  } catch {
    return null;
  }
  const parsed = agentSessionSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    log("warn", "智能体会话文件无法解析", { sessionId, ownerId });
    return null;
  }
  // 路径里已经有 ownerId 了，这一行守的是「文件被手工挪过 / 改过」的情况。
  if (parsed.data.ownerId !== ownerId) return null;
  return parsed.data;
}

/** 原子写：先写临时文件再 rename，半截 JSON 不会成为某个人的会话。 */
export async function writeSession(session: AgentSession): Promise<AgentSession> {
  await writeJsonAtomic(agentSessionPath(session.ownerId, session.id), session);
  return session;
}

/** 列表按 `updatedAt` 倒序（新→旧）。坏文件跳过而不是让整个抽屉 500。 */
export async function listSessions(ownerId: string): Promise<AgentSessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(agentUserDir(ownerId));
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => AGENT_SESSION_ID_RE.test(id));
  const sessions = await Promise.all(ids.map((id) => readSession(ownerId, id)));
  return sessions
    .filter((s): s is AgentSession => s !== null)
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(s.skillId ? { skillId: s.skillId } : {}),
    }))
    .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function countSessions(ownerId: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(agentUserDir(ownerId));
  } catch {
    return 0;
  }
  return names.filter((name) => AGENT_SESSION_ID_RE.test(name.replace(/\.json$/, ""))).length;
}

/**
 * 开一个新会话（还没有任何消息）。上限在锁内判：出了锁，两个并发的「新建」都会读到
 * 199 然后一起写进去。
 */
export async function createSession(
  ownerId: string,
  init: Pick<AgentSession, "title"> & Partial<Pick<AgentSession, "skillId" | "tier" | "imageProduct" | "videoProduct">>,
): Promise<AgentSession> {
  return withAgentLock(async () => {
    if ((await countSessions(ownerId)) >= MAX_SESSIONS_PER_USER) {
      throw new ProviderHttpError(
        409,
        "too_many_sessions",
        `会话数量已达上限（${MAX_SESSIONS_PER_USER}），请先删除一些旧会话`,
      );
    }
    const now = new Date().toISOString();
    return writeSession({
      schemaVersion: 1,
      id: newSessionId(),
      ownerId,
      title: init.title,
      ...(init.skillId ? { skillId: init.skillId } : {}),
      ...(init.tier ? { tier: init.tier } : {}),
      ...(init.imageProduct ? { imageProduct: init.imageProduct } : {}),
      ...(init.videoProduct ? { videoProduct: init.videoProduct } : {}),
      messages: [],
      jobIds: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

export type SessionPatch = Partial<
  Pick<AgentSession, "title" | "skillId" | "tier" | "imageProduct" | "videoProduct">
>;

/**
 * 追加一轮的消息（用户 + 助手）并顺手更新会话头。
 *
 * 读的是**锁内的新鲜副本**，不是调用方几秒前拿到的那份：那几秒里 LLM 在跑，另一轮
 * 可能已经写进去了，拿旧副本回写就会把它抹掉。会话在这期间被删掉时返回 `null`。
 */
export async function appendTurn(
  ownerId: string,
  sessionId: string,
  messages: AgentMessage[],
  jobIds: string[],
  patch: SessionPatch = {},
): Promise<AgentSession | null> {
  return withAgentLock(async () => {
    const current = await readSession(ownerId, sessionId);
    if (!current) return null;
    // 消息 id 去重（R08）：同一个 turnId 的两轮并发先后落进这把锁时，第二轮在这里
    // 变成空操作——不然一次 HTTP 重试会在会话里留下一对重复的「问 + 答」。
    const known = new Set(current.messages.map((m) => m.id));
    const fresh = messages.filter((m) => !known.has(m.id));
    // 一整轮都被去重掉时连会话头也不动：这是一次重放，不该悄悄改掉设置。
    if (!fresh.length) return current;
    const next: AgentSession = {
      ...current,
      ...stripUndefined(patch),
      messages: [...current.messages, ...fresh],
      jobIds: [...new Set([...current.jobIds, ...jobIds])],
      updatedAt: new Date().toISOString(),
    };
    return writeSession(next);
  });
}

export async function patchSession(
  ownerId: string,
  sessionId: string,
  patch: SessionPatch & { budgetCny?: number | null },
): Promise<AgentSession | null> {
  return withAgentLock(async () => {
    const current = await readSession(ownerId, sessionId);
    if (!current) return null;
    const { budgetCny, ...rest } = patch;
    const budget =
      budgetCny === undefined
        ? current.budget
        : budgetCny === null
          ? undefined
          : { limitCny: budgetCny, spentCny: current.budget?.spentCny ?? 0 };
    return writeSession({
      ...current,
      ...stripUndefined(rest),
      budget,
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * 通用读-改-写（B 包 turn 状态机用）：`fn` 在会话锁内拿到**新鲜副本**，返回 `null` /
 * `undefined` 表示「不改」（原样交回，不动 updatedAt）。与 `appendTurn` 的锁内重读
 * 同一条纪律——调用方手里那份可能是几秒前的。
 */
export async function updateSession(
  ownerId: string,
  sessionId: string,
  fn: (s: AgentSession) => AgentSession | null | undefined,
): Promise<AgentSession | null> {
  return withAgentLock(async () => {
    const current = await readSession(ownerId, sessionId);
    if (!current) return null;
    const next = fn(current);
    if (!next) return current;
    return writeSession({ ...next, updatedAt: new Date().toISOString() });
  });
}

/**
 * 删会话。删的是对话记录，**不删任务**：那些作品已经在主页的作品流里，是独立的东西
 * （也已经付过钱了），跟着对话一起消失才是意外。
 */
export async function deleteSession(ownerId: string, sessionId: string): Promise<boolean> {
  return withAgentLock(async () => {
    const current = await readSession(ownerId, sessionId);
    if (!current) return false;
    await rm(agentSessionPath(ownerId, sessionId), { force: true });
    return true;
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
