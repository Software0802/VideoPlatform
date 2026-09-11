import { readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { withUserLock } from "@/lib/users/lock";
import { type UserRecord } from "@/lib/users/schema";
import { assertUserId, readUser, writeUser } from "@/lib/users/store";
import { splitAcrossPools as splitShared, snapshotRows, parseLegacy } from "./protocol.mjs";
import { commitChange, checkExport, rebuildExport, readText } from "./file-ledger.mjs";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * 余额变动与流水（方案 §3.2）。
 *
 * `user.json` 是资金事实的唯一提交点：`balanceCny` / `memberCreditsCny` 与产生它们的
 * 流水（`billing.operations`）在**同一次原子写**里落盘，「余额变了、流水没记上」这种
 * 状态从此不可能存在——这正是 R01 要堵的窗口。`data/ledger/<userId>.jsonl` 降级为
 * **派生导出物**（由 `billing.legacyLedger` + `operations` 重建），供对账与
 * `/api/me/ledger` 展示用；它与快照不一致（被手改 / 截断成非前缀）时读取与提交都
 * 失败关闭（`billing_export_corrupt`），只缺不损时自动重建。
 *
 * 协议细节（快照校验、链式重放、幂等键、人工核对迁移）在 `protocol.mjs` /
 * `file-ledger.mjs`（.mjs 因为管理 CLI 也要用，不能 import TS）。存量账号没有
 * `billing` 字段：可读旧流水，但一切余额变动报 `billing_migration_required`，须先跑
 * `scripts/migrate-billing.mjs --offline --baseline <已核对基线.json>`。
 *
 * 2026-09-06 起余额有**两个池**（方案 §3.2）：`balanceCny` 是已购池（礼品码 / 管理员
 * 充值），`memberCreditsCny` 是订阅送的会员积分池（期末清零）。扣款默认先扣会员池、
 * 不足部分才扣已购池；入账按 `pool` 参数选池。订阅购买是唯一强制只扣已购池的调用方
 * （`pool: "purchased"`）——否则「订阅送的积分又能拿去买订阅」就是无限套利。
 *
 * 默认扣款只认**有效**会员池：订阅到期后（结算是惰性的，记录可能还躺在 user.json 里）
 * 那笔钱整笔不参与扣款，见 `poolFor`——与 `admission.loadBalanceUsage` 的准入口径同一份判据。
 */

/** 余额的两个池。默认（不传）= 扣款先会员后已购、入账进已购。 */
export type BalancePool = "purchased" | "member";

export type BalanceChangeOptions = {
  /**
   * 指定这一笔只动哪个池。
   * - 入账（正 delta）：钱进哪个池，缺省进已购池。
   * - 扣款（负 delta）：`"purchased"` = 绕开会员池只扣已购（订阅购买）；
   *   `"member"` = 只扣会员池且截在 0（期末清零）；缺省 = 先会员后已购。
   */
  pool?: BalancePool;
  /**
   * 退款原路回池（R02）：正 delta 时指向原扣款行的 `ref`，按那笔 charge 的
   * `memberCny` 拆回——会员池出的部分退回会员池（哪怕订阅已过期、等结算清零，
   * 也不转成永久已购余额），其余进已购池。与 `pool` 互斥；原扣款找不到则
   * `billing_refund_source_missing` 失败关闭，不猜池子。
   */
  refundOf?: string;
};

export const LEDGER_KINDS = ["grant", "charge", "adjust"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type LedgerEntry = {
  at: string;
  /** `grant` 管理员充值 / 礼品码兑换 / `charge` 任务成功扣款 / `adjust` 人工纠正。 */
  kind: LedgerKind;
  /** 变动额，人民币元，扣款为负。 */
  amountCny: number;
  balanceAfterCny: number;
  jobId?: string;
  /**
   * 礼品码兑换写的幂等键（只出现在 `kind: "grant"` 上）。作用与 `charge` 的 `jobId`
   * 完全对称：一张码在一个人的流水里最多产生一行入账，`redeemGiftCode` 的补入账
   * 分支靠它保证重放不会重复给钱。`scripts/grant-balance.mjs` 不写这个字段——
   * 管理员充值没有天然的幂等键，也不需要。
   */
  giftCode?: string;
  /**
   * 通用幂等键（2026-09-06 订阅 / 智能体引入）。同一个人、同一 `kind`、同一 `ref` 的行
   * 最多出现一次——订阅扣款 `sub:<幂等键>`、会员积分入账 `sub:<subId>:p<n>`、每日积分
   * `sub:<subId>:d<YYYY-MM-DD>`、智能体一轮扣款 `agent:<turnId>` 都靠它保证重放不重复。
   * 语义与 `jobId` / `giftCode` 完全对称，新增的补扣 / 补入账路径一律用它，不要再加新字段。
   */
  ref?: string;
  /**
   * 这笔扣款中由会员积分池承担的部分（正数，人民币元），只出现在**扣款行**上
   * （`charge`，以及会员池清零 / 重置那两条负向 `adjust`——它们同样是「钱从会员池
   * 出去」，不记这个字段的话那两行会长得像什么都没发生）。
   * `amountCny` 是总扣款额；`balanceAfterCny` 只反映已购余额池，会员池余量见 `user.json`
   * 的 `memberCreditsCny`。
   */
  memberCny?: number;
  note?: string;
  /**
   * 订单快照（R04）：订阅购买的 charge 行带上原订单的档位 / 周期 / 价格 / 下单时刻。
   * 「扣款成功、写订阅前崩掉」的补建按这份快照履约——不按当前价目重算、不许同 key
   * 换参数买另一档。内部字段，`toEntry` 不下发到前端。
   */
  order?: {
    planId: string;
    cycle: "monthly" | "yearly";
    priceCny: number;
    orderedAt: string;
  };
};

/**
 * 调用方能写的字段。`balanceAfterCny` / `at` 由内核填；`memberCny` 也是**算出来的**
 * （由 `options.pool` 与当时的会员池余量决定），谁都不该自己报一个数进来。
 */
export type LedgerEntryInput = Omit<LedgerEntry, "at" | "balanceAfterCny" | "memberCny">;

/**
 * 一次变动怎么落到两个池上。纯函数，方便直接测。
 *
 * 会员池永不为负：`pool: "member"` 的扣款截在池子余量（清零时正好扣光），默认扣款
 * 也只从会员池取它拿得出的部分，剩下的推给已购池——已购池允许为负（见上面的注释）。
 */
export function splitAcrossPools(
  balanceCny: number,
  memberCreditsCny: number,
  delta: number,
  pool?: BalancePool,
): { balanceCny: number; memberCreditsCny: number; memberCny: number } {
  // `pool: "member"` 时差额直接抹掉（不转嫁给已购池）：它的用途只有「把会员池清零」。
  return splitShared(balanceCny, memberCreditsCny, delta, pool);
}

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
 * 重放必须是**同键同输入**：同一个幂等键（jobId / giftCode / ref）撞上一条输入不同
 * 的操作会抛 `billing_idempotency_conflict`（409），而不是默默跳过——键被两个不同
 * 语义的调用复用是数据事故，必须浮出来。
 */
export async function applyBalanceChange(
  userId: string,
  delta: number,
  entry: LedgerEntryInput,
  options: BalanceChangeOptions = {},
): Promise<UserRecord> {
  return withUserLock(() => applyBalanceChangeLocked(userId, delta, entry, options));
}

/**
 * `applyBalanceChange` 的锁内内核。**调用方必须已经持有 `withUserLock`**——
 * `withUserLock` 是一条进程级串行队列，在锁里再调 `applyBalanceChange` 会死锁。
 *
 * 存在的唯一理由是礼品码兑换（`src/lib/users/gift-codes.ts`）：认领码（写 `usedBy`）与
 * 入账必须是同一个临界区，否则中间那一瞬别的请求能看到「码已被认领、钱还没到」的
 * 半成品状态。扣款 / 充值的实现只有这一份，AGENTS.md 的「任何补扣路径都必须复用同一个
 * 幂等函数」由此成立：外面那层壳只加锁，不加逻辑。
 */
export async function applyBalanceChangeLocked(
  userId: string,
  delta: number,
  entry: LedgerEntryInput,
  options: BalanceChangeOptions = {},
): Promise<UserRecord> {
  if (!Number.isFinite(delta)) throw new Error("非法余额变动");
  const user = await readUser(userId);
  if (!user) throw new Error(`用户不存在: ${userId}`);
  // 幂等去重必须在锁内：出了锁，两个并发的同 jobId 扣款会一起读到「还没扣过」。
  // 同理，一张礼品码在一个人的流水里只入账一次。
  // 通用幂等键：同 kind + 同 ref 只记一次。
  try {
    return await commitChange(user, { delta, entry, options }, {
      ledgerFile: ledgerFilePath(userId),
      write: writeUser,
      exportLedger: (record: UserRecord) => appendLedger(userId, record),
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 409 && "code" in error) {
      throw new ProviderHttpError(409, String(error.code), error.message);
    }
    throw error;
  }
}

/**
 * 这一笔实际该动哪个池。
 *
 * 只在**默认扣款**（负 delta、调用方没点名池子）这一种情况下动手：订阅已经过期时，
 * 会员池里剩下的钱是「等着被下一次结算清掉」的死账，不该再拿去付任务——准入那边
 * （`loadBalanceUsage`）已经不把它算进 `available` 了，扣款这边要是照旧先扣会员池，
 * 两边就会各说各话：判定按「不够」拒了，真扣起来又从一个不该存在的池子里出了钱。
 * 过期就整笔落到已购池，与准入口径逐字一致。
 *
 * 显式的 `pool` 一律原样放行：`"member"` 正是清零 / 重置那条路（过期时更要能用），
 * `"purchased"` 是订阅购买的硬约束。
 */
async function readDecisionRows(userId: string): Promise<LedgerEntry[]> {
  const user = await readUser(userId);
  if (user?.billing) {
    await checkExport(user, ledgerFilePath(userId));
    return snapshotRows(user);
  }
  return parseLegacy((await readText(ledgerFilePath(userId), true)) ?? "");
}

/** 通用幂等键的判据：这个人的流水里是否已有同 `kind` 同 `ref` 的一行。 */
export async function hasEntryFor(userId: string, kind: LedgerKind, ref: string): Promise<boolean> {
  return (await findEntryFor(userId, kind, ref)) !== null;
}

/** 同 `hasEntryFor`，但把那行本身交回来——R04 要读扣款行上的订单快照。 */
export async function findEntryFor(
  userId: string,
  kind: LedgerKind,
  ref: string,
): Promise<LedgerEntry | null> {
  const rows = await readDecisionRows(userId);
  return rows.find((row) => row.kind === kind && row.ref === ref) ?? null;
}

/**
 * 这个用户的流水里是否已经有这条任务的扣款行。
 *
 * 已迁移账号读 `user.json` 里的 billing 快照（顺带核对导出文件没被动过），未迁移的
 * 旧账号退回全量扫 jsonl——流水每人一份、一次任务一行，内测规模下比维护一份索引
 * 可靠得多，而且它就是对账时人眼看的那份东西，判据和证据是同一个。
 *
 * 无锁读。`applyBalanceChangeLocked` 在 `withUserLock` 里调它，外部调用（测试、对账）
 * 拿到的是当下快照。
 */
export async function hasChargeFor(userId: string, jobId: string): Promise<boolean> {
  const rows = await readDecisionRows(userId);
  return rows.some((row) => row.kind === "charge" && row.jobId === jobId);
}

/** 同款判据，用于礼品码：这个人的流水里是否已经有这张码的入账行。 */
export async function hasGiftGrantFor(userId: string, giftCode: string): Promise<boolean> {
  const rows = await readDecisionRows(userId);
  return rows.some((row) => row.kind === "grant" && row.giftCode === giftCode);
}

/**
 * 读出全量流水，保持时间顺序。
 *
 * 已迁移账号：在用户锁里核对并重建导出文件（`rebuildExport`），然后返回快照行——
 * 导出物与快照对不上时抛 `billing_export_corrupt`，不做「坏行跳过」。
 * 未迁移账号：退回旧路径逐行读 jsonl，坏行跳过、没有文件返回空。
 */
async function readLedgerRows(userId: string): Promise<Partial<LedgerEntry>[]> {
  const user = await readUser(userId);
  if (user?.billing) {
    return withUserLock(async () => {
      const current = await readUser(userId);
      if (!current?.billing) throw new Error("billing_snapshot_missing");
      await rebuildExport(current, ledgerFilePath(userId));
      return snapshotRows(current);
    });
  }
  let raw: string;
  try {
    raw = await readFile(ledgerFilePath(userId), "utf8");
  } catch {
    return [];
  }
  const rows: Partial<LedgerEntry>[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") rows.push(parsed as Partial<LedgerEntry>);
  }
  return rows;
}

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export type ReadLedgerOptions = {
  /** 只要严格早于这个时刻（ISO）的行；上一页返回的 `nextBefore` 原样传回来即可。 */
  before?: string;
  /** 默认 50，上限 200。 */
  limit?: number;
  /** 可选过滤。在分页**之前**生效，否则一页里能剩几行全看运气。 */
  kind?: LedgerKind;
};

export type LedgerPage = {
  /** 按 `at` 倒序（新→旧）。 */
  entries: LedgerEntry[];
  /** 还有更旧的行时给出：下一页传 `before=nextBefore`。到底了就没有这个字段。 */
  nextBefore?: string;
};

/**
 * 读一页流水（方案 §1.7「积分使用详情」）。已迁移账号走 billing 快照（用户锁内
 * 顺带自愈导出文件），未迁移账号读 jsonl——流水只增不改，读到的永远是一份自洽的
 * 快照，最多漏掉刚追加的一行。
 *
 * 排序以 `at` 为准、同刻按文件里的先后（后写的更新）兜底：文件本身就是时间序，
 * 只有系统时钟回拨才会让两者不一致，这时以 `at` 为准更符合用户看到的东西。
 *
 * ⚠️ 游标是「严格早于 `before`」。同一毫秒里写了多行时，跨页边界可能漏掉与游标同刻
 * 的那几行——内测规模（一人一天几行）下不会发生，真要发生也只是明细少一行，不影响
 * 余额本身（余额的事实源是 `user.json`）。
 */
export async function readLedger(
  userId: string,
  options: ReadLedgerOptions = {},
): Promise<LedgerPage> {
  const rows = await readLedgerRows(userId);
  const all: LedgerEntry[] = [];
  for (const row of rows) {
    const entry = toEntry(row);
    if (entry) all.push(entry);
  }
  // 稳定倒序：先记下原始序号，`at` 相等时用它兜底。
  const ordered = all
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.at === b.entry.at ? b.index - a.index : a.entry.at < b.entry.at ? 1 : -1))
    .map((item) => item.entry);

  const filtered = ordered.filter((entry) => {
    if (options.kind && entry.kind !== options.kind) return false;
    if (options.before && !(entry.at < options.before)) return false;
    return true;
  });

  const limit = clampLimit(options.limit);
  const entries = filtered.slice(0, limit);
  const hasMore = filtered.length > entries.length;
  const last = entries[entries.length - 1];
  return hasMore && last ? { entries, nextBefore: last.at } : { entries };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return LEDGER_PAGE_DEFAULT;
  return Math.min(LEDGER_PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/** 一行只有形状对得上才算数；对不上的按坏行处理（与 `readLedgerRows` 同一条纪律）。 */
function toEntry(row: Partial<LedgerEntry>): LedgerEntry | null {
  if (typeof row.at !== "string" || !row.at) return null;
  if (!LEDGER_KINDS.includes(row.kind as LedgerKind)) return null;
  if (typeof row.amountCny !== "number" || !Number.isFinite(row.amountCny)) return null;
  if (typeof row.balanceAfterCny !== "number" || !Number.isFinite(row.balanceAfterCny)) return null;
  return {
    at: row.at,
    kind: row.kind as LedgerKind,
    amountCny: row.amountCny,
    balanceAfterCny: row.balanceAfterCny,
    ...(typeof row.jobId === "string" ? { jobId: row.jobId } : {}),
    ...(typeof row.giftCode === "string" ? { giftCode: row.giftCode } : {}),
    ...(typeof row.ref === "string" ? { ref: row.ref } : {}),
    ...(typeof row.memberCny === "number" && Number.isFinite(row.memberCny) ? { memberCny: row.memberCny } : {}),
    ...(typeof row.note === "string" ? { note: row.note } : {}),
  };
}

async function appendLedger(userId: string, record: UserRecord): Promise<void> {
  // jsonl 不再是追加写：它是 billing 快照的导出物，每次整体重建（原子 rename）。
  await rebuildExport(record, ledgerFilePath(userId));
}
