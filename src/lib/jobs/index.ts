import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { canAccessJob } from "@/lib/jobs/ownership";
import {
  isTerminalStatus,
  jobPublicSchema,
  jobStatusSchema,
  nativeModeSchema,
  type JobRecord,
  type JobStatus,
} from "@/lib/jobs/schema";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";

/**
 * `data/jobs/index.json` —— 任务的派生索引（方案 §3.3「IO」，P2）。
 *
 * 在它之前，六个调用方（首页 SSR、配额、余额准入、`activeCount`、`pump`、留存清理）
 * 各自把 `data/jobs/*​/job.json` **全量串行读一遍**，于是每一条历史任务都会让每一次
 * 提交更慢一点。索引把「问一个问题要读几个文件」从 N 降到 1（进程内还是 0）。
 *
 * 三条纪律，照 `src/lib/users/store.ts` 的 `index.json` 抄：
 *
 * 1. **它是缓存，不是事实源。** 事实源永远是 `job.json`。索引与目录对不上时，以目录
 *    为准重建，而不是反过来信索引。
 * 2. **写序固定：先 job.json，后索引。** 崩在两次写之间只会丢索引（下次重建补回），
 *    不会丢任务本身。落盘还带 200ms 防抖——一条任务从提交到出片会写十几次盘，每次都
 *    重写整份索引是拿一个 IO 问题换另一个。
 * 3. **读之前先对一次目录。** 每次 `listJobIndex` 只多一次 `readdir`（不读任何
 *    job.json），目录名集合与索引键对不上就重建。这条是为了「有人绕过 store 直接写了
 *    一份 job.json」——e2e 与单测就是这么造数据的，生产里则是手工修数据。
 *
 * 索引**故意不存** `error.code`：止损阀要按它区分「用户的失败」和「平台的失败」，而它
 * 只对「今天失败 / 取消的那几条」有意义，配额那边为这几条回读 job.json 就够了，不必让
 * 每一次状态写入都把错误信息也搬进索引。
 */

const INDEX_FILE = "index.json";
/** 目录名 / 任务 id 的合法字符集，与 `storage/local-fs.ts` 的 `assertSafeId` 同一份。 */
const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
/**
 * 落盘防抖。一条任务的生命周期里 `updateJob` 会被调用十几次（submit、每次轮询进度、
 * persist、结算），200ms 内的连写合并成一次整文件重写；崩溃最多丢这 200ms 的索引，
 * 而 job.json 每一次都是实打实落了盘的。
 */
const FLUSH_DEBOUNCE_MS = 200;

export type JobIndexEntry = {
  id: string;
  ownerId?: string;
  status: JobStatus;
  mode: JobRecord["mode"];
  createdAt: string;
  /**
   * 方案 §3.3 的字段表里没有它，这里补上：留存清理与配额判定的「结算时刻」是
   * `completedAt ?? updatedAt`，老记录没有 `completedAt`，少了这条就只能回读 job.json，
   * 索引也就白建了。
   */
  updatedAt: string;
  completedAt?: string;
  artifactsPurgedAt?: string;
  priceCny: number;
  provider: JobRecord["provider"];
  outputKind?: "video" | "image";
  /**
   * 创建时的幂等键（若带）。进索引的理由与别的判定字段一致：幂等映射文件丢了的
   * 时候，恢复路径扫索引就能找到「这个 key 建了哪条任务」，不用回读每个 job.json。
   */
  idempotencyKey?: string;
};

const jobIndexEntrySchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  status: jobStatusSchema,
  mode: nativeModeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  artifactsPurgedAt: z.string().optional(),
  priceCny: z.number(),
  provider: jobPublicSchema.shape.provider,
  outputKind: z.enum(["video", "image"]).optional(),
  idempotencyKey: z.string().optional(),
});

const jobIndexFileSchema = z.record(z.string(), jobIndexEntrySchema);

export type JobIndexFilter = {
  /** 只要 `ownerId` 恰好等于它的任务。 */
  ownerId?: string;
  /**
   * 可见性口径（`canAccessJob`）：本人的任务，外加管理员才看得见的无主历史任务。
   * 首页与列表用它，钱的口径（配额 / 余额）用 `ownerId` —— 无主任务不属于任何人的账。
   */
  forUser?: string;
  /** 只要这几个状态。 */
  status?: readonly JobStatus[];
  /** true = 只要非终态，false = 只要终态；不传 = 都要。 */
  nonTerminal?: boolean;
  /** 取前 n 条（已按时间倒序）。 */
  limit?: number;
};

export function jobsDir(): string {
  return path.join(dataDir(), "jobs");
}

export function jobIndexPath(): string {
  return path.join(jobsDir(), INDEX_FILE);
}

type IndexCache = {
  /** 缓存绑定到数据根：测试换 `DATA_DIR` 时绝不能读到上一个工作区的索引。 */
  root: string;
  /** key 是**目录名**，`entry.id` 是记录自称的 id。正常情况下两者相同。 */
  entries: Map<string, JobIndexEntry>;
  timer?: NodeJS.Timeout;
  dirty: boolean;
};

type GlobalIndexState = typeof globalThis & { __lumenJobIndex?: IndexCache };
const globalIndexState = globalThis as GlobalIndexState;

function cached(): IndexCache | null {
  const entry = globalIndexState.__lumenJobIndex;
  return entry && entry.root === jobsDir() ? entry : null;
}

function setCache(entries: Map<string, JobIndexEntry>): IndexCache {
  const previous = cached();
  if (previous?.timer) clearTimeout(previous.timer);
  const next: IndexCache = { root: jobsDir(), entries, dirty: false };
  globalIndexState.__lumenJobIndex = next;
  return next;
}

/** 丢掉进程内缓存；下一次读重新从磁盘建。测试与启动用。 */
export function resetJobIndexCache(): void {
  const previous = globalIndexState.__lumenJobIndex;
  if (previous?.timer) clearTimeout(previous.timer);
  delete globalIndexState.__lumenJobIndex;
}

/** 目录名列表。索引文件自己、原子写留下的 `.tmp`、任何不合法的名字都不算任务。 */
async function listJobDirNames(): Promise<string[]> {
  try {
    const names = await readdir(jobsDir());
    return names.filter((name) => JOB_ID_RE.test(name));
  } catch {
    return [];
  }
}

async function readRecordIn(dirName: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(path.join(jobsDir(), dirName, "job.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

function outputKindOf(rec: JobRecord): "video" | "image" | undefined {
  const raw = rec.output as { kind?: string; videoUrl?: string; imageUrl?: string } | null;
  if (!raw) return undefined;
  if (raw.kind === "video" || raw.kind === "image") return raw.kind;
  if (typeof raw.videoUrl === "string") return "video";
  if (typeof raw.imageUrl === "string") return "image";
  return undefined;
}

/** 一条记录在索引里的样子。缺字段的老记录按「读出即默认」处理，不抛。 */
export function toIndexEntry(rec: JobRecord): JobIndexEntry {
  const entry: JobIndexEntry = {
    id: rec.id,
    status: rec.status,
    mode: rec.mode,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    priceCny: typeof rec.priceCny === "number" && Number.isFinite(rec.priceCny) ? rec.priceCny : 0,
    provider: rec.provider,
  };
  if (rec.ownerId) entry.ownerId = rec.ownerId;
  if (rec.completedAt) entry.completedAt = rec.completedAt;
  if (rec.artifactsPurgedAt) entry.artifactsPurgedAt = rec.artifactsPurgedAt;
  const kind = outputKindOf(rec);
  if (kind) entry.outputKind = kind;
  if (rec.idempotency?.key) entry.idempotencyKey = rec.idempotency.key;
  return entry;
}

/** 扫 `data/jobs/*​/job.json`——唯一的事实源——重建整份映射。 */
async function buildFromDisk(): Promise<Map<string, JobIndexEntry>> {
  const names = (await listJobDirNames()).sort();
  const map = new Map<string, JobIndexEntry>();
  for (const name of names) {
    const rec = await readRecordIn(name);
    if (!rec || typeof rec.id !== "string" || !rec.status) continue;
    map.set(name, toIndexEntry(rec));
  }
  return map;
}

async function readIndexFile(): Promise<Map<string, JobIndexEntry> | null> {
  try {
    const raw = await readFile(jobIndexPath(), "utf8");
    const parsed = jobIndexFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return new Map(Object.entries(parsed.data));
  } catch {
    return null;
  }
}

async function writeIndexFile(entries: Map<string, JobIndexEntry>): Promise<void> {
  // 目录不在就别把它建回来：`data/jobs` 还没有任何任务（或测试已经清理掉数据根）时，
  // 写一份空索引只会凭空造出目录，而空索引本来也不含任何信息。
  const dir = jobsDir();
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return;
  } catch {
    return;
  }
  const object: Record<string, JobIndexEntry> = {};
  for (const key of [...entries.keys()].sort()) object[key] = entries.get(key)!;
  await writeJsonAtomic(path.join(dir, INDEX_FILE), object);
}

function sameKeys(entries: Map<string, JobIndexEntry>, names: readonly string[]): boolean {
  if (entries.size !== names.length) return false;
  for (const name of names) if (!entries.has(name)) return false;
  return true;
}

/**
 * 冷启动一次全量扫盘，之后每次只多一个 `readdir` 做校验。
 *
 * 冷路径**故意不信** `index.json` 的内容，只拿它和重建结果对比、不一致就重写并告警：
 * 索引是钱与配额的判定输入（在途预留、今日用量），拿一份可能停在崩溃前 200ms 的快照
 * 当真相，省下的那点 IO 不值得。
 */
let inflight: { root: string; promise: Promise<Map<string, JobIndexEntry>> } | null = null;

async function loadIndex(): Promise<Map<string, JobIndexEntry>> {
  const root = jobsDir();
  // 单飞：`/api/me` 一个请求里就有两个调用方并发进来（配额与余额），冷启动那次全量扫盘
  // 会被同时跑两遍。合并成一次，省下的是 N 次读盘而不是一次判断。
  if (inflight && inflight.root === root) return inflight.promise;
  const promise = loadIndexOnce();
  inflight = { root, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

async function loadIndexOnce(): Promise<Map<string, JobIndexEntry>> {
  const hit = cached();
  const names = await listJobDirNames();
  if (hit) {
    await healAgainstDirs(hit, names);
    return hit.entries;
  }

  const rebuilt = await buildFromDisk();
  const fromFile = await readIndexFile();
  if (!fromFile || !sameKeys(fromFile, [...rebuilt.keys()])) {
    if (fromFile) {
      log("warn", "job index out of date, rebuilt from job.json files", {
        indexed: fromFile.size,
        scanned: rebuilt.size,
      });
    }
    await writeIndexFile(rebuilt);
  }
  setCache(rebuilt);
  return rebuilt;
}

/**
 * 热缓存与目录对齐。**增量**修，不整份重建：
 *
 * - 索引里有、目录没了 → 摘掉（有人手工删了任务目录）。
 * - 目录有、索引里没有 → 只读这几个目录的 job.json 补进来（e2e / 单测就是这样直接
 *   写一份 job.json 造数据的）。
 *
 * 「目录在但 job.json 还没写」不算不一致：`create.ts` 先建目录收上传、几百毫秒后才
 * `writeJob`，把这个窗口判成不一致会让每一次并发上传都触发一次全量重建——正是这套
 * 索引要消灭的东西。这样的目录这一轮跳过，等它真的有了记录再补。
 */
async function healAgainstDirs(cache: IndexCache, names: readonly string[]): Promise<void> {
  const present = new Set(names);
  let changed = 0;
  for (const key of [...cache.entries.keys()]) {
    if (present.has(key)) continue;
    cache.entries.delete(key);
    changed += 1;
  }
  for (const name of names) {
    if (cache.entries.has(name)) continue;
    const rec = await readRecordIn(name);
    if (!rec || typeof rec.id !== "string" || !rec.status) continue;
    cache.entries.set(name, toIndexEntry(rec));
    changed += 1;
  }
  if (changed) {
    log("info", "job index healed against data/jobs", { changed, size: cache.entries.size });
    scheduleFlush(cache);
  }
}

/** 启动钩子（`src/instrumentation.ts`）：丢掉缓存，按目录重建一次并落盘。 */
export async function ensureJobIndex(): Promise<void> {
  resetJobIndexCache();
  await loadIndex();
}

/** 强制全量重建（脚本 / 排障用）。 */
export async function rebuildJobIndex(): Promise<JobIndexEntry[]> {
  const rebuilt = await buildFromDisk();
  await writeIndexFile(rebuilt);
  setCache(rebuilt);
  return [...rebuilt.values()];
}

function scheduleFlush(cache: IndexCache): void {
  cache.dirty = true;
  if (cache.timer) return;
  cache.timer = setTimeout(() => {
    cache.timer = undefined;
    void flushJobIndex();
  }, FLUSH_DEBOUNCE_MS);
  // 短命进程（测试、脚本）不该被一个还没到期的索引落盘拖住。
  cache.timer.unref?.();
}

/** 立刻落盘（防抖到期时自己调；测试想确定性地看到文件也可以直接调）。 */
export async function flushJobIndex(): Promise<void> {
  const cache = cached();
  if (!cache || !cache.dirty) return;
  cache.dirty = false;
  try {
    await writeIndexFile(cache.entries);
  } catch (error) {
    // 索引写失败不是事故：事实源已经落盘了，下次重建会补回来。
    log("warn", "job index flush failed", {
      msg: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 写完 job.json 之后把这条记录同步进索引（`store.writeJob` / `store.updateJob` 调用，
 * 且必须在写盘**之后**）。
 *
 * 这里刻意不做 `readdir` 校验：写方自己就是变化的来源，为每一次状态写入多跑一次目录
 * 校验只会把节省下来的 IO 还回去。
 */
export async function upsertJobIndex(rec: JobRecord): Promise<void> {
  const cache = await warmCache();
  if (!cache) return;
  cache.entries.set(rec.id, toIndexEntry(rec));
  scheduleFlush(cache);
}

/** 任务目录被删掉之后把它从索引里摘掉（`jobs/delete.ts` 的 `deleteJobById` 调用）。 */
export async function removeFromJobIndex(id: string): Promise<void> {
  const cache = await warmCache();
  if (!cache) return;
  if (!cache.entries.delete(id)) return;
  scheduleFlush(cache);
}

/** 冷缓存时先全量建一次，之后写方直接改内存里的那份。 */
async function warmCache(): Promise<IndexCache | null> {
  const hit = cached();
  if (hit) return hit;
  await loadIndex();
  return cached();
}

/**
 * 按 owner / 状态筛，按 `createdAt` 倒序（同刻按 id 倒序，保证稳定）。
 *
 * 返回的是索引条目，不是完整记录：需要提示词、成片、错误详情的调用方拿到 id 之后再去
 * 读那几份 job.json——「先筛后读」是这一整套的要点，全量读盘的只剩 `recover()`。
 */
export async function listJobIndex(filter: JobIndexFilter = {}): Promise<JobIndexEntry[]> {
  const entries = await loadIndex();
  const wanted = filter.status ? new Set(filter.status) : null;
  const out: JobIndexEntry[] = [];
  for (const entry of entries.values()) {
    if (filter.ownerId !== undefined && entry.ownerId !== filter.ownerId) continue;
    if (filter.forUser !== undefined && !canAccessJob(entry, filter.forUser)) continue;
    if (wanted && !wanted.has(entry.status)) continue;
    if (filter.nonTerminal !== undefined && isTerminalStatus(entry.status) === filter.nonTerminal) {
      continue;
    }
    out.push(entry);
  }
  out.sort((a, b) => (a.createdAt === b.createdAt ? cmpDesc(a.id, b.id) : cmpDesc(a.createdAt, b.createdAt)));
  return filter.limit !== undefined ? out.slice(0, Math.max(0, filter.limit)) : out;
}

function cmpDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}
