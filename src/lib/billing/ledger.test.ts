import { access, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * 余额变动与流水（方案 §3.2）。`user.json.balanceCny` 是事实源，
 * `data/ledger/<userId>.jsonl` 是只增流水；`applyBalanceChange` 全程在
 * `withUserLock` 里，见 `src/lib/users/store.test.ts` 同款临时 DATA_DIR 写法。
 */

let dataRoot = "";
let applyBalanceChange: typeof import("./ledger").applyBalanceChange;
let splitAcrossPools: typeof import("./ledger").splitAcrossPools;
let ledgerFilePath: typeof import("./ledger").ledgerFilePath;
let hasChargeFor: typeof import("./ledger").hasChargeFor;
let readLedger: typeof import("./ledger").readLedger;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-ledger-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ applyBalanceChange, ledgerFilePath, hasChargeFor, readLedger, splitAcrossPools } = await import(
    "./ledger"
  ));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

const DAY_MS = 86_400_000;

/** 一份还没到期（或已经到期）的订阅，用来给会员池一个合法的存在理由。 */
function subscriptionRecord(expiresInDays: number) {
  const startedAt = new Date(Date.now() - DAY_MS).toISOString();
  return {
    id: "sub_00000000000000ff",
    planId: "standard" as const,
    cycle: "monthly" as const,
    startedAt,
    expiresAt: new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
    periodIndex: 0,
    periodStartedAt: startedAt,
  };
}

/**
 * 有会员积分就顺手配一份**生效中**的订阅：默认扣款只认有效会员池（`poolFor`），
 * 一个没有订阅撑着的会员池在扣款眼里等于零——那是「孤儿池」，等着下一次结算清掉。
 * 要验那条路的用例传 `expiresInDays` 为负数。
 */
async function seedUser(
  id: string,
  balanceCny: number,
  memberCreditsCny = 0,
  expiresInDays = 30,
): Promise<UserRecord> {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    memberCreditsCny,
    ...(memberCreditsCny > 0 ? { subscription: subscriptionRecord(expiresInDays) } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function readLedgerLines(id: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(ledgerFilePath(id), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("applyBalanceChange", () => {
  it("grants add to the balance and append one self-describing ledger line", async () => {
    const id = userId("1");
    await seedUser(id, 10);

    const next = await applyBalanceChange(id, 5, { kind: "grant", amountCny: 5, note: "充值" });
    expect(next.balanceCny).toBe(15);
    expect((await readUser(id))?.balanceCny).toBe(15);

    const lines = await readLedgerLines(id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "grant", amountCny: 5, balanceAfterCny: 15, note: "充值" });
    expect(typeof lines[0]?.at).toBe("string");
    expect(lines[0]).not.toHaveProperty("jobId");
  });

  it("charges (negative delta) and allows the balance to go negative", async () => {
    const id = userId("2");
    await seedUser(id, 3);

    const next = await applyBalanceChange(id, -5, { kind: "charge", amountCny: -5, jobId: "job_x" });
    expect(next.balanceCny).toBe(-2);
    const lines = await readLedgerLines(id);
    expect(lines[0]).toMatchObject({ kind: "charge", amountCny: -5, balanceAfterCny: -2, jobId: "job_x" });
  });

  it("rounds both the stored balance and the ledgered amount to 2 decimals", async () => {
    const id = userId("3");
    await seedUser(id, 0.1);
    const next = await applyBalanceChange(id, 0.2, { kind: "adjust", amountCny: 0.2 });
    // 0.1 + 0.2 is 0.30000000000000004 in raw float arithmetic.
    expect(next.balanceCny).toBe(0.3);
    const lines = await readLedgerLines(id);
    expect(lines[0]?.amountCny).toBe(0.2);
    expect(lines[0]?.balanceAfterCny).toBe(0.3);
  });

  it("serializes 10 concurrent +1 grants into a final balance of +10, one ledger line each", async () => {
    const id = userId("4");
    await seedUser(id, 0);

    await Promise.all(
      Array.from({ length: 10 }, () => applyBalanceChange(id, 1, { kind: "grant", amountCny: 1 })),
    );

    expect((await readUser(id))?.balanceCny).toBe(10);
    const lines = await readLedgerLines(id);
    expect(lines).toHaveLength(10);
    // Every recorded balanceAfterCny is unique and the final one matches the settled balance —
    // if the lock had let two writers interleave, two lines would share a balanceAfterCny.
    const afters = lines.map((l) => l.balanceAfterCny);
    expect(new Set(afters).size).toBe(10);
    expect(Math.max(...(afters as number[]))).toBe(10);
  });

  it("rejects a non-finite delta and touches neither the balance nor the ledger", async () => {
    const id = userId("5");
    await seedUser(id, 7);

    await expect(applyBalanceChange(id, Number.NaN, { kind: "adjust", amountCny: 0 })).rejects.toThrow(
      "非法余额变动",
    );
    expect((await readUser(id))?.balanceCny).toBe(7);
    await expect(access(ledgerFilePath(id))).rejects.toThrow();
  });

  it("rejects a change for a user that does not exist, writing no ledger file", async () => {
    const id = userId("6");
    await expect(applyBalanceChange(id, 1, { kind: "grant", amountCny: 1 })).rejects.toThrow();
    await expect(access(ledgerFilePath(id))).rejects.toThrow();
  });
});

/**
 * `charge` + `jobId` is idempotent, which is what lets `store.updateJob` charge *before*
 * it writes the terminal record: a crash between the two, or a later retry of the same
 * job, replays the charge and must not take the money twice. The ledger — append-only,
 * and the thing a human reconciles against — is the dedupe key.
 */
describe("applyBalanceChange charge idempotency", () => {
  it("charges a jobId once; the replay leaves balance and ledger untouched", async () => {
    const id = userId("7");
    await seedUser(id, 10);

    const first = await applyBalanceChange(id, -2, { kind: "charge", amountCny: -2, jobId: "job_dup" });
    expect(first.balanceCny).toBe(8);

    const replay = await applyBalanceChange(id, -2, { kind: "charge", amountCny: -2, jobId: "job_dup" });
    // Returns the *current* record rather than throwing: the caller's contract is
    // "this job is paid for", and it already is.
    expect(replay.balanceCny).toBe(8);
    expect((await readUser(id))?.balanceCny).toBe(8);
    expect(await readLedgerLines(id)).toHaveLength(1);
  });

  it("serializes 5 concurrent charges of the same jobId into exactly one deduction", async () => {
    const id = userId("8");
    await seedUser(id, 10);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        applyBalanceChange(id, -2, { kind: "charge", amountCny: -2, jobId: "job_race" }),
      ),
    );

    // The dedupe read lives inside `withUserLock`; outside it, all five would read
    // "not charged yet" and the balance would land on 0.
    expect((await readUser(id))?.balanceCny).toBe(8);
    expect(await readLedgerLines(id)).toHaveLength(1);
  });

  it("dedupes per jobId, and not at all for grants or for a charge without one", async () => {
    const id = userId("9");
    await seedUser(id, 10);

    await applyBalanceChange(id, -1, { kind: "charge", amountCny: -1, jobId: "job_a" });
    await applyBalanceChange(id, -1, { kind: "charge", amountCny: -1, jobId: "job_b" });
    await applyBalanceChange(id, -1, { kind: "charge", amountCny: -1 });
    await applyBalanceChange(id, 5, { kind: "grant", amountCny: 5 });
    await applyBalanceChange(id, 5, { kind: "grant", amountCny: 5 });

    expect((await readUser(id))?.balanceCny).toBe(17);
    expect(await readLedgerLines(id)).toHaveLength(5);
  });
});


/**
 * 两个池（订阅方案 §3.2）。会员池是订阅送的、期末清零的那份钱，任务扣款先扣它；
 * 订阅购买反过来只许扣已购池——否则「买订阅得积分 → 用积分再买订阅」就是无限套利。
 */
describe("两个池的扣款与入账", () => {
  it("扣款先扣会员池，超出的部分才扣已购池，流水记下会员池承担的那一半", async () => {
    const id = userId("c1");
    await seedUser(id, 10, 4);

    const next = await applyBalanceChange(id, -6, { kind: "charge", amountCny: -6, jobId: "job_pool" });
    expect(next.memberCreditsCny).toBe(0);
    expect(next.balanceCny).toBe(8);

    const line = (await readLedgerLines(id))[0];
    // balanceAfterCny 只说已购池；会员池承担的部分单独记 memberCny，两个数加起来才是这一笔。
    expect(line).toMatchObject({ kind: "charge", amountCny: -6, balanceAfterCny: 8, memberCny: 4 });
  });

  it("会员池够付时一分钱都不动已购池，也不写 memberCny 之外的东西", async () => {
    const id = userId("c2");
    await seedUser(id, 10, 5);
    const next = await applyBalanceChange(id, -3, { kind: "charge", amountCny: -3, jobId: "job_m" });
    expect(next.memberCreditsCny).toBe(2);
    expect(next.balanceCny).toBe(10);
    expect((await readLedgerLines(id))[0]).toMatchObject({ balanceAfterCny: 10, memberCny: 3 });
  });

  it("pool:purchased 绕开会员池（订阅购买），会员池原封不动", async () => {
    const id = userId("c3");
    await seedUser(id, 10, 5);
    const next = await applyBalanceChange(
      id,
      -8,
      { kind: "charge", amountCny: -8, ref: "sub:sub_1" },
      { pool: "purchased" },
    );
    expect(next.balanceCny).toBe(2);
    expect(next.memberCreditsCny).toBe(5);
    expect((await readLedgerLines(id))[0]).not.toHaveProperty("memberCny");
  });

  it("pool:member 的入账只进会员池，已购池与它的 balanceAfterCny 都不变", async () => {
    const id = userId("c4");
    await seedUser(id, 10, 0);
    const next = await applyBalanceChange(
      id,
      12,
      { kind: "grant", amountCny: 12, ref: "sub:sub_1:p0" },
      { pool: "member" },
    );
    expect(next.memberCreditsCny).toBe(12);
    expect(next.balanceCny).toBe(10);
    expect((await readLedgerLines(id))[0]).toMatchObject({ balanceAfterCny: 10, amountCny: 12 });
  });

  it("pool:member 的扣款截在池子余量，绝不把差额转嫁给已购池", async () => {
    const id = userId("c5");
    await seedUser(id, 10, 3);
    const next = await applyBalanceChange(
      id,
      -3,
      { kind: "adjust", amountCny: -3, ref: "sub:sub_1:end" },
      { pool: "member" },
    );
    expect(next.memberCreditsCny).toBe(0);
    expect(next.balanceCny).toBe(10);
  });

  it("同 kind + 同 ref 的重放不重复入账（订阅的每一步都靠它幂等）", async () => {
    const id = userId("c6");
    await seedUser(id, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      await applyBalanceChange(
        id,
        0.6,
        { kind: "grant", amountCny: 0.6, ref: "sub:sub_1:d2026-09-06" },
        { pool: "member" },
      );
    }
    expect((await readUser(id))?.memberCreditsCny).toBe(0.6);
    expect(await readLedgerLines(id)).toHaveLength(1);
  });

  it("订阅已过期时默认扣款整笔走已购池，一分钱都不从会员池出", async () => {
    const id = userId("c7");
    // 昨天就到期了，但结算是惰性的（还没有任何请求读过这个账号），所以会员池还留着 5 元。
    await seedUser(id, 10, 5, -1);
    const next = await applyBalanceChange(id, -4, {
      kind: "charge",
      amountCny: -4,
      jobId: "job_expired_member",
    });
    // 准入那边已经不把这 5 元算进 available 了；扣款这边要是照旧先扣会员池，
    // 两边就会各说各话——过期积分照样花得出去。
    expect(next.balanceCny).toBe(6);
    expect(next.memberCreditsCny).toBe(5);
    expect((await readLedgerLines(id))[0]).not.toHaveProperty("memberCny");
  });

  it("过期之后 pool:member 的清零照样能扣：结算就是靠它把死账扫掉的", async () => {
    const id = userId("c8");
    await seedUser(id, 10, 5, -1);
    const next = await applyBalanceChange(
      id,
      -5,
      { kind: "adjust", amountCny: -5, ref: "sub:sub_00000000000000ff:end" },
      { pool: "member" },
    );
    expect(next.memberCreditsCny).toBe(0);
    expect(next.balanceCny).toBe(10);
  });

  it("splitAcrossPools 是纯函数：会员池永不为负，已购池允许为负", () => {
    expect(splitAcrossPools(10, 4, -6)).toEqual({ balanceCny: 8, memberCreditsCny: 0, memberCny: 4 });
    expect(splitAcrossPools(1, 0, -3)).toEqual({ balanceCny: -2, memberCreditsCny: 0, memberCny: 0 });
    expect(splitAcrossPools(10, 4, -6, "purchased")).toEqual({
      balanceCny: 4,
      memberCreditsCny: 4,
      memberCny: 0,
    });
    expect(splitAcrossPools(10, 4, -9, "member")).toEqual({
      balanceCny: 10,
      memberCreditsCny: 0,
      memberCny: 4,
    });
    expect(splitAcrossPools(10, 4, 5, "member")).toEqual({
      balanceCny: 10,
      memberCreditsCny: 9,
      memberCny: 0,
    });
  });
});

describe("hasChargeFor", () => {
  it("is false with no ledger file, true once that jobId has been charged", async () => {
    const id = userId("a");
    await seedUser(id, 10);
    expect(await hasChargeFor(id, "job_h")).toBe(false);

    await applyBalanceChange(id, -1, { kind: "charge", amountCny: -1, jobId: "job_h" });
    expect(await hasChargeFor(id, "job_h")).toBe(true);
    expect(await hasChargeFor(id, "job_other")).toBe(false);
  });

  it("ignores non-charge rows carrying the same jobId, but rejects a charge after ledger corruption", async () => {
    const id = userId("b");
    await seedUser(id, 10);
    await applyBalanceChange(id, 3, { kind: "grant", amountCny: 3, jobId: "job_g", note: "补偿" });
    expect(await hasChargeFor(id, "job_g")).toBe(false);

    // A half-written or hand-edited line must not make a charge throw — skip it and
    // keep reading, or a single bad byte would block every future deduction.
    await appendFile(ledgerFilePath(id), "{not json\n", "utf8");
    await expect(
      applyBalanceChange(id, -1, { kind: "charge", amountCny: -1, jobId: "job_g" }),
    ).rejects.toThrow();
    expect((await readUser(id))?.balanceCny).toBe(13);
  });
});

/**
 * 契约 A2：`readLedger(userId, { before?, limit? })` 倒序分页，`nextBefore`。
 * 落账一律走 `applyBalanceChange`（流水行由 billing ops 导出，不再允许手写进
 * jsonl），可控的 `at` 用 `vi.useFakeTimers` 钉住，分页边界才能稳定断言。
 */
describe("readLedger", () => {
  it("returns entries newest-first with a nextBefore cursor mid-list, and none on the final page", async () => {
    // "e" — every single-char tag through "d" is already claimed by an earlier describe
    // block sharing this file's DATA_DIR (applyBalanceChange uses "1".."9", hasChargeFor
    // uses "a"/"b"); reusing one here would append these hand-timestamped rows onto an
    // existing ledger file that already has real-clock rows, corrupting the ordering.
    const id = userId("e1");
    await seedUser(id, 0);
    const times = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ];
    // 流水行只能由 billing ops 提交产生，不能再往导出文件里手写；三行的 at 用假时钟钉住。
    vi.useFakeTimers();
    try {
      for (const [i, at] of times.entries()) {
        vi.setSystemTime(new Date(at));
        await applyBalanceChange(id, 1, { kind: "grant", amountCny: 1, note: `g${i}` });
      }
    } finally {
      vi.useRealTimers();
    }

    const first = await readLedger(id, { limit: 2 });
    expect(first.entries.map((e) => e.at)).toEqual([times[2], times[1]]); // newest first
    expect(first.nextBefore).toBe(times[1]);

    const second = await readLedger(id, { limit: 2, before: first.nextBefore });
    expect(second.entries.map((e) => e.at)).toEqual([times[0]]);
    expect(second.nextBefore).toBeUndefined(); // reached the oldest row
  });

  it("filters by kind before paginating, and a hand-edited export line fails closed", async () => {
    const id = userId("e2");
    await seedUser(id, 0);
    await applyBalanceChange(id, 5, { kind: "grant", amountCny: 5 });
    await applyBalanceChange(id, -2, { kind: "charge", amountCny: -2, jobId: "job_1" });

    const grantsOnly = await readLedger(id, { kind: "grant" });
    expect(grantsOnly.entries).toHaveLength(1);
    expect(grantsOnly.entries[0]).toMatchObject({ kind: "grant", amountCny: 5 });

    const everything = await readLedger(id);
    expect(everything.entries).toHaveLength(2);

    // jsonl 文件现在是由 user.json 里的 billing ops 重建的**导出物**，不再是事实源：
    // 一行塞进来但快照里没有的手工行 = 导出与事实源对不上，读取按损坏失败关闭，
    // 而不是默默跳过（流水现在参与幂等判定，「读不懂就跳」会让一笔扣款凭空消失）。
    await appendFile(ledgerFilePath(id), "{not json\n", "utf8");
    await expect(readLedger(id)).rejects.toThrow("billing_export_corrupt");
  });

  it("clamps limit into [1, LEDGER_PAGE_MAX] instead of returning zero rows or throwing", async () => {
    const id = userId("e3");
    await seedUser(id, 0);
    for (let i = 0; i < 3; i += 1) {
      await applyBalanceChange(id, 1, { kind: "grant", amountCny: 1, note: `g${i}` });
    }

    const zeroLimit = await readLedger(id, { limit: 0 });
    expect(zeroLimit.entries).toHaveLength(1); // clamped up to the floor of 1, not 0

    const hugeLimit = await readLedger(id, { limit: 100000 });
    expect(hugeLimit.entries).toHaveLength(3); // only 3 rows exist; the LEDGER_PAGE_MAX ceiling just doesn't bind here
  });
});
