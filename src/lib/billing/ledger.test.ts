import { access, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
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
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-ledger-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ applyBalanceChange, ledgerFilePath, hasChargeFor } = await import("./ledger"));
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
