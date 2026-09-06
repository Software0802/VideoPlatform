import { access, appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * 余额变动与流水（方案 §3.2）。`user.json.balanceCny` 是事实源，
 * `data/ledger/<userId>.jsonl` 是只增流水；`applyBalanceChange` 全程在
 * `withUserLock` 里，见 `src/lib/users/store.test.ts` 同款临时 DATA_DIR 写法。
 */

let dataRoot = "";
let applyBalanceChange: typeof import("./ledger").applyBalanceChange;
let ledgerFilePath: typeof import("./ledger").ledgerFilePath;
let hasChargeFor: typeof import("./ledger").hasChargeFor;
let readLedger: typeof import("./ledger").readLedger;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-ledger-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ applyBalanceChange, ledgerFilePath, hasChargeFor, readLedger } = await import("./ledger"));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

async function seedUser(id: string, balanceCny: number): Promise<UserRecord> {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
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

describe("hasChargeFor", () => {
  it("is false with no ledger file, true once that jobId has been charged", async () => {
    const id = userId("a");
    await seedUser(id, 10);
    expect(await hasChargeFor(id, "job_h")).toBe(false);

    await applyBalanceChange(id, -1, { kind: "charge", amountCny: -1, jobId: "job_h" });
    expect(await hasChargeFor(id, "job_h")).toBe(true);
    expect(await hasChargeFor(id, "job_other")).toBe(false);
  });

  it("ignores non-charge rows carrying the same jobId, and survives a corrupt line", async () => {
    const id = userId("b");
    await seedUser(id, 10);
    await applyBalanceChange(id, 3, { kind: "grant", amountCny: 3, jobId: "job_g", note: "补偿" });
    expect(await hasChargeFor(id, "job_g")).toBe(false);

    // A half-written or hand-edited line must not make a charge throw — skip it and
    // keep reading, or a single bad byte would block every future deduction.
    await appendFile(ledgerFilePath(id), "{not json\n", "utf8");
    await applyBalanceChange(id, -1, { kind: "charge", amountCny: -1, jobId: "job_g" });
    expect(await hasChargeFor(id, "job_g")).toBe(true);
    expect((await readUser(id))?.balanceCny).toBe(12);
  });
});

/**
 * 契约 A2：`readLedger(userId, { before?, limit? })` 倒序分页，坏行跳过，`nextBefore`。
 * 直接手写 jsonl 行（而不是走 `applyBalanceChange`）以拿到可控的 `at` 时间戳，
 * 分页边界才能被稳定断言，不依赖真实时钟先后。
 */
describe("readLedger", () => {
  async function seedLine(
    id: string,
    entry: {
      at: string;
      kind: "grant" | "charge" | "adjust";
      amountCny: number;
      balanceAfterCny: number;
      jobId?: string;
      giftCode?: string;
    },
  ) {
    const file = ledgerFilePath(id);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  }

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
    for (const [i, at] of times.entries()) {
      await seedLine(id, { at, kind: "grant", amountCny: 1, balanceAfterCny: i + 1 });
    }

    const first = await readLedger(id, { limit: 2 });
    expect(first.entries.map((e) => e.at)).toEqual([times[2], times[1]]); // newest first
    expect(first.nextBefore).toBe(times[1]);

    const second = await readLedger(id, { limit: 2, before: first.nextBefore });
    expect(second.entries.map((e) => e.at)).toEqual([times[0]]);
    expect(second.nextBefore).toBeUndefined(); // reached the oldest row
  });

  it("filters by kind before paginating, and silently skips a corrupt line", async () => {
    const id = userId("e2");
    await seedUser(id, 0);
    await seedLine(id, { at: "2026-02-01T00:00:00.000Z", kind: "grant", amountCny: 5, balanceAfterCny: 5 });
    await seedLine(id, {
      at: "2026-02-02T00:00:00.000Z",
      kind: "charge",
      amountCny: -2,
      balanceAfterCny: 3,
      jobId: "job_1",
    });
    // A half-written or hand-edited line must not throw and must not count as a row.
    await appendFile(ledgerFilePath(id), "{not json\n", "utf8");

    const grantsOnly = await readLedger(id, { kind: "grant" });
    expect(grantsOnly.entries).toHaveLength(1);
    expect(grantsOnly.entries[0]).toMatchObject({ kind: "grant", amountCny: 5 });

    const everything = await readLedger(id);
    expect(everything.entries).toHaveLength(2); // the corrupt line contributed nothing
  });

  it("clamps limit into [1, LEDGER_PAGE_MAX] instead of returning zero rows or throwing", async () => {
    const id = userId("e3");
    await seedUser(id, 0);
    for (let i = 0; i < 3; i += 1) {
      await seedLine(id, {
        at: `2026-03-0${i + 1}T00:00:00.000Z`,
        kind: "grant",
        amountCny: 1,
        balanceAfterCny: i + 1,
      });
    }

    const zeroLimit = await readLedger(id, { limit: 0 });
    expect(zeroLimit.entries).toHaveLength(1); // clamped up to the floor of 1, not 0

    const hugeLimit = await readLedger(id, { limit: 100000 });
    expect(hugeLimit.entries).toHaveLength(3); // only 3 rows exist; the LEDGER_PAGE_MAX ceiling just doesn't bind here
  });
});
