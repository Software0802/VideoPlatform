import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listJobIndex } from "@/lib/jobs/index";
import { idempotencyDir, readJob } from "@/lib/jobs/store";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";

/**
 * `data/idempotency/<sha256(owner + key)>.json` —— 「这个幂等键建了哪条任务」的
 * **缓存**，不是事实源（R07）。事实源是 `job.json` 上的 `idempotency.{key,requestHash}`：
 * 任务记录先落盘、映射后写（`create.ts`），崩在两者之间只会丢映射——下一次同 key
 * 请求在 `lookupIdempotency` 里按任务索引把它重建回来，而不是把同一笔创建再做一遍。
 *
 * 反过来「映射写了、任务没落盘」的窗口不存在：`saveIdempotency` 恒在 `writeJob`
 * 之后调用。所以映射命中时可以信任它指向 jobId，但命中后仍回读一次 job.json 交叉
 * 验证——文件被人手工改过 / 停在半截写时，不能照单全收。
 */

type Entry = { jobId: string; createdAt: string };

const TTL_MS = 24 * 3600 * 1000;

export async function lookupIdempotency(ownerId: string, key: string): Promise<string | null> {
  const entry = await readMapping(ownerId, key);
  if (entry) {
    // 命中不等于可信：回读任务记录，它必须真的认领这个 key（`idempotency.key`）。
    // 老记录没有这个字段——它们的幂等只存在于映射文件里，只能按归属沿用旧语义。
    const rec = await readJob(entry.jobId).catch(() => null);
    if (rec && rec.ownerId === ownerId && (!rec.idempotency || rec.idempotency.key === key)) {
      return entry.jobId;
    }
    // 映射指向的任务不认这个 key：文件被污染或停在半截写，别信它，按事实源重找。
  }
  const recovered = await findJobByIdempotencyKey(ownerId, key);
  if (recovered) await saveIdempotency(ownerId, key, recovered);
  return recovered;
}

/**
 * 按任务索引（`job.json` 上的 `idempotency.key`，经 `JobIndexEntry.idempotencyKey`
 * 投影）找这个 key 的持有者。索引同样是派生物，命中后回读 job.json 再确认一遍——
 * 这条路径的唯一判据是任务记录本身。
 */
export async function findJobByIdempotencyKey(
  ownerId: string,
  key: string,
): Promise<string | null> {
  const entries = await listJobIndex({ ownerId });
  const holder = entries.find((entry) => entry.idempotencyKey === key);
  if (!holder) return null;
  const rec = await readJob(holder.id).catch(() => null);
  if (!rec || rec.ownerId !== ownerId || rec.idempotency?.key !== key) return null;
  return holder.id;
}

export async function saveIdempotency(ownerId: string, key: string, jobId: string) {
  const entry: Entry = { jobId, createdAt: new Date().toISOString() };
  await writeJsonAtomic(fileFor(ownerId, key), entry);
}

async function readMapping(ownerId: string, key: string): Promise<Entry | null> {
  try {
    const entry = JSON.parse(await readFile(fileFor(ownerId, key), "utf8")) as Entry;
    if (typeof entry.jobId !== "string" || !entry.jobId) return null;
    const age = Date.now() - new Date(entry.createdAt).getTime();
    if (!Number.isFinite(age) || age > TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * 一次创建请求的正则哈希（同 key 异参的判据）。剔除 `idempotencyKey` 本身——key 是
 * 定位符，不是参数；其余字段按键名排序后序列化，语义相同的请求体哈希必然相同。
 */
export function idempotencyRequestHash(body: Record<string, unknown>): string {
  const rest = { ...body };
  delete rest.idempotencyKey;
  return stableJsonHash(rest);
}

/**
 * 任意值的正则哈希（D 包：画布报价 hash 与幂等 requestHash 共用同一种
 * 「键名排序后序列化」口径，避免两处各自实现再漂移）。
 */
export function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * The filename is namespaced by the owner (plan §5.2). Hashing the client key
 * alone let anyone who guessed someone else's key replay — and be handed — that
 * person's job. As a side effect, records written before this change hash to a
 * different name and simply never match, which is the intended "ownerless
 * idempotency records count as a miss".
 */
function fileFor(ownerId: string, key: string) {
  const hash = createHash("sha256").update(`${ownerId}\0${key}`).digest("hex");
  return path.join(idempotencyDir(), `${hash}.json`);
}
