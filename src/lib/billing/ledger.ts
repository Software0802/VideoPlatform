import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { withUserLock } from "@/lib/users/lock";
import type { UserRecord } from "@/lib/users/schema";
import { assertUserId, readUser, writeUser } from "@/lib/users/store";

/**
 * 余额变动与流水（方案 §3.2）。
 *
 * `user.json` 的 `balanceCny` 是余额的事实源，`data/ledger/<userId>.jsonl` 是**只增**
 * 的流水，供对账用——它不参与任何判定，所以一行写失败也不会让余额本身错，但反过来
 * 余额写成功、流水没写上，对账就少一条，因此顺序是「先改余额、再追加流水」，且流水
 * 里记的是改完之后的余额，任何一行都能自证。
 */

export type LedgerEntry = {
  at: string;
  /** `grant` 管理员充值 / `charge` 任务成功扣款 / `adjust` 人工纠正。 */
  kind: "grant" | "charge" | "adjust";
  /** 变动额，人民币元，扣款为负。 */
  amountCny: number;
  balanceAfterCny: number;
  jobId?: string;
  note?: string;
};

export function ledgerDir(): string {
  return path.join(dataDir(), "ledger");
}

export function ledgerFilePath(userId: string): string {
  assertUserId(userId);
  return path.join(ledgerDir(), `${userId}.jsonl`);
}

/**
 * 余额加 `delta` 并追加一行流水，返回改写后的用户记录。
 *
 * 全程在 `withUserLock` 里：`user.json` 是读-改-写，和注册 / 改密走的是同一把锁，
 * 否则一次并发的改密就能把刚扣的钱覆盖回去。这把锁是进程级串行锁（不是 per-user），
 * 与 `users/service.ts` 保持一致——用户级写入本来就稀疏，多一套锁只会漏掉互斥。
 *
 * 余额允许被扣成负数：预留是在准入时算的，走到这里说明任务已经产生了上游花费，
 * 这时候拒绝扣款只会让账目对不上。
 *
 * **带 `jobId` 的 `charge` 是幂等的**：锁内先扫一遍流水，同一个 jobId 已经扣过就
 * 原样返回当前用户记录，不改余额也不追加流水。`store.updateJob` 靠这条保证「扣款
 * 在写盘之前」不会因为崩溃 / 重试变成重复扣款（见那边的崩溃语义注释）。判据放在
 * 流水里而不是任务记录里，是因为流水是只增的：任务 json 可能还没落盘，流水已经
 * 是既成事实。
 *
 * ⚠️ 落盘格式与 `scripts/grant-balance.mjs` 逐字一致（.mjs 不能 import TS），
 * 改这里必须同步改那边。
 */
export async function applyBalanceChange(
  userId: string,
  delta: number,
  entry: Omit<LedgerEntry, "at" | "balanceAfterCny">,
): Promise<UserRecord> {
  if (!Number.isFinite(delta)) throw new Error("非法余额变动");
  return withUserLock(async () => {
    const user = await readUser(userId);
    if (!user) throw new Error(`用户不存在: ${userId}`);
    // 幂等去重必须在锁内：出了锁，两个并发的同 jobId 扣款会一起读到「还没扣过」。
    if (entry.kind === "charge" && entry.jobId && (await hasChargeFor(userId, entry.jobId))) {
      return user;
    }
    const balanceCny = round2(user.balanceCny + delta);
    const next = await writeUser({ ...user, balanceCny });
    await appendLedger(userId, {
      at: new Date().toISOString(),
      kind: entry.kind,
      amountCny: round2(entry.amountCny),
      balanceAfterCny: balanceCny,
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    });
    return next;
  });
}

/**
 * 这个用户的流水里是否已经有这条任务的扣款行。
 *
 * 只读一遍 jsonl 全量扫：流水是每人一个文件、一次任务一行，内测规模下比维护一份
 * 索引可靠得多——而且它就是对账时人眼看的那份东西，判据和证据是同一个。
 * 坏行（半截写入 / 手工编辑）跳过而不是抛错：一行读不懂不该让扣款失败。
 *
 * 无锁读。`applyBalanceChange` 在 `withUserLock` 里调它，外部调用（测试、对账）
 * 拿到的是当下快照。
 */
export async function hasChargeFor(userId: string, jobId: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(ledgerFilePath(userId), "utf8");
  } catch {
    // 还没有流水文件 = 这个人一分钱都没动过，自然也没扣过这条任务。
    return false;
  }
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const row = parsed as Partial<LedgerEntry>;
    if (row.kind === "charge" && row.jobId === jobId) return true;
  }
  return false;
}

async function appendLedger(userId: string, line: LedgerEntry): Promise<void> {
  const file = ledgerFilePath(userId);
  await mkdir(path.dirname(file), { recursive: true });
  // 一行一条 JSON，追加写：并发只在锁内发生，单行 append 也不会把两条写串。
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
