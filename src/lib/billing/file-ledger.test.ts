import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntryInput } from "./ledger";

const fault = vi.hoisted(() => ({
  userFile: "",
  ledgerFile: "",
  mode: "off" as "off" | "before-export" | "after-export" | "read-denied",
  userCommits: 0,
  failures: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const paths = await import("node:path");
  const isLedgerTarget = (file: unknown) => String(file) === fault.ledgerFile;
  const isLedgerWrite = (file: unknown) => {
    const name = String(file);
    return isLedgerTarget(file) || (
      paths.dirname(name) === paths.dirname(fault.ledgerFile) &&
      paths.basename(name).includes(paths.basename(fault.ledgerFile))
    );
  };
  const fail = (code: string) => {
    fault.failures += 1;
    throw Object.assign(new Error(`injected ledger ${code}`), { code });
  };
  const beforeWrite = (file: unknown) => {
    if (fault.mode === "before-export" && fault.userCommits > 0 && isLedgerWrite(file)) fail("EIO");
  };
  const afterWrite = (file: unknown) => {
    if (fault.mode === "after-export" && fault.userCommits > 0 && isLedgerTarget(file)) fail("EIO");
  };
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      beforeWrite(args[0]);
      await actual.appendFile(...args);
      afterWrite(args[0]);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      beforeWrite(args[0]);
      await actual.writeFile(...args);
      afterWrite(args[0]);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      beforeWrite(args[1]);
      await actual.rename(...args);
      if (String(args[1]) === fault.userFile) fault.userCommits += 1;
      afterWrite(args[1]);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (fault.mode === "read-denied" && isLedgerTarget(args[0])) fail("EACCES");
      return actual.readFile(...args);
    },
  };
});

type Fixture = {
  id: string;
  fs: typeof import("node:fs/promises");
  ledger: typeof import("./ledger");
  store: typeof import("@/lib/users/store");
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const previousDataDir = process.env.DATA_DIR;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lumen-file-ledger-test-"));
  try {
    process.env.DATA_DIR = root;
    vi.resetModules();
    const ledger = await import("./ledger");
    const store = await import("@/lib/users/store");
    const id = "usr_0000000000000f01";
    fault.mode = "off";
    fault.userFile = store.userFilePath(id);
    fault.ledgerFile = ledger.ledgerFilePath(id);
    await store.writeUser({
      id,
      email: "file-ledger@example.com",
      passwordHash: "fixture-hash",
      sessionEpoch: 1,
      plan: "free",
      balanceCny: 10,
      memberCreditsCny: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    fault.userCommits = 0;
    fault.failures = 0;
    await run({ id, fs, ledger, store });
  } finally {
    fault.mode = "off";
    fault.userFile = "";
    fault.ledgerFile = "";
    fault.userCommits = 0;
    fault.failures = 0;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function diskRows(fs: Fixture["fs"]) {
  const raw = await fs.readFile(fault.ledgerFile, "utf8");
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

const replayCases: Array<{ name: string; delta: number; entry: LedgerEntryInput }> = [
  { name: "jobId charge", delta: -2, entry: { kind: "charge", amountCny: -2, jobId: "job_fault" } },
  { name: "ref charge", delta: -2, entry: { kind: "charge", amountCny: -2, ref: "agent:fault" } },
  { name: "giftCode grant", delta: 3, entry: { kind: "grant", amountCny: 3, giftCode: "GIFT-FAULT" } },
  { name: "refund ref", delta: 2, entry: { kind: "adjust", amountCny: 2, ref: "agent:fault:refund" } },
];

describe("file ledger atomic balance and replay boundaries", () => {
  it.each(replayCases)("$name replays once after user rename succeeds and ledger export fails", async ({ delta, entry }) => {
    await withFixture(async ({ id, fs, ledger }) => {
      fault.mode = "before-export";
      await expect(ledger.applyBalanceChange(id, delta, entry)).rejects.toThrow("injected ledger EIO");
      expect(fault.userCommits).toBe(1);
      expect(fault.failures).toBeGreaterThan(0);
      expect(JSON.parse(await fs.readFile(fault.userFile, "utf8")).balanceCny).toBe(10 + delta);
      await expect(fs.access(fault.ledgerFile)).rejects.toMatchObject({ code: "ENOENT" });

      fault.mode = "off";
      vi.resetModules();
      const restarted = await import("./ledger");
      if (entry.jobId) expect.soft(await restarted.hasChargeFor(id, entry.jobId)).toBe(true);
      if (entry.giftCode) expect.soft(await restarted.hasGiftGrantFor(id, entry.giftCode)).toBe(true);
      if (entry.ref) expect.soft(await restarted.hasEntryFor(id, entry.kind, entry.ref)).toBe(true);
      const replay = await restarted.applyBalanceChange(id, delta, entry);
      expect.soft(replay.balanceCny).toBe(10 + delta);
      expect.soft(JSON.parse(await fs.readFile(fault.userFile, "utf8")).balanceCny).toBe(10 + delta);
      const rows = await diskRows(fs);
      expect(rows).toHaveLength(1);
      expect.soft(rows[0]).toMatchObject({ ...entry, balanceAfterCny: 10 + delta });
      await restarted.applyBalanceChange(id, delta, entry);
      expect.soft(JSON.parse(await fs.readFile(fault.userFile, "utf8")).balanceCny).toBe(10 + delta);
      expect(await diskRows(fs)).toHaveLength(1);
    });
  });

  it("does not duplicate an exported line when the filesystem reports failure after the export committed", async () => {
    await withFixture(async ({ id, fs, ledger }) => {
      const entry = { kind: "charge" as const, amountCny: -2, jobId: "job_exported" };
      fault.mode = "after-export";
      await expect(ledger.applyBalanceChange(id, -2, entry)).rejects.toThrow("injected ledger EIO");
      expect(fault.userCommits).toBe(1);
      expect(fault.failures).toBeGreaterThan(0);
      const exported = await fs.readFile(fault.ledgerFile, "utf8");
      expect(await diskRows(fs)).toHaveLength(1);
      fault.mode = "off";
      vi.resetModules();
      const restarted = await import("./ledger");
      await restarted.applyBalanceChange(id, -2, entry);
      await restarted.applyBalanceChange(id, -2, entry);
      expect(JSON.parse(await fs.readFile(fault.userFile, "utf8")).balanceCny).toBe(8);
      expect(await fs.readFile(fault.ledgerFile, "utf8")).toBe(exported);
      expect(await diskRows(fs)).toHaveLength(1);
    });
  });

  it("fails closed without rewriting user.json or corrupt ledger bytes", async () => {
    await withFixture(async ({ id, fs, ledger }) => {
      await fs.mkdir(path.dirname(fault.ledgerFile), { recursive: true });
      const corrupt = '{"kind":"charge","jobId":"job_broken"\n';
      await fs.writeFile(fault.ledgerFile, corrupt, "utf8");
      const snapshot = await fs.readFile(fault.userFile, "utf8");
      await expect.soft(ledger.applyBalanceChange(id, -2, {
        kind: "charge", amountCny: -2, jobId: "job_broken",
      })).rejects.toThrow();
      expect.soft(await fs.readFile(fault.userFile, "utf8")).toBe(snapshot);
      expect.soft(await fs.readFile(fault.ledgerFile, "utf8")).toBe(corrupt);
      expect.soft(fault.userCommits).toBe(0);
    });
  });

  it("does not treat EACCES reading an existing ledger as an empty account", async () => {
    await withFixture(async ({ id, fs, ledger }) => {
      await fs.mkdir(path.dirname(fault.ledgerFile), { recursive: true });
      await fs.writeFile(fault.ledgerFile, `${JSON.stringify({
        at: "2026-01-01T00:00:00.000Z", kind: "charge", amountCny: -2,
        balanceAfterCny: 10, jobId: "job_denied",
      })}\n`, "utf8");
      const snapshot = await fs.readFile(fault.userFile, "utf8");
      const exported = await fs.readFile(fault.ledgerFile, "utf8");
      fault.mode = "read-denied";
      await expect.soft(ledger.applyBalanceChange(id, -2, {
        kind: "charge", amountCny: -2, jobId: "job_denied",
      })).rejects.toThrow();
      expect(fault.failures).toBeGreaterThan(0);
      expect.soft(await fs.readFile(fault.userFile, "utf8")).toBe(snapshot);
      expect.soft(await fs.readFile(fault.ledgerFile, "utf8")).toBe(exported);
      expect.soft(fault.userCommits).toBe(0);
    });
  });

  it.each(replayCases)("rejects a different amount for the same $name key", async ({ delta, entry }) => {
    await withFixture(async ({ id, fs, ledger }) => {
      await ledger.applyBalanceChange(id, delta, entry);
      const snapshot = await fs.readFile(fault.userFile, "utf8");
      const exported = await fs.readFile(fault.ledgerFile, "utf8");
      await expect.soft(ledger.applyBalanceChange(id, delta * 2, {
        ...entry, amountCny: delta * 2,
      })).rejects.toThrow();
      expect(await fs.readFile(fault.userFile, "utf8")).toBe(snapshot);
      expect(await fs.readFile(fault.ledgerFile, "utf8")).toBe(exported);
    });
  });

  it("preserves committed replay evidence through password and profile writes before export recovery", async () => {
    await withFixture(async ({ id, fs, ledger, store }) => {
      const entry = { kind: "charge" as const, amountCny: -2, ref: "agent:profile" };
      fault.mode = "before-export";
      await expect(ledger.applyBalanceChange(id, -2, entry)).rejects.toThrow("injected ledger EIO");
      expect(fault.userCommits).toBe(1);
      fault.mode = "off";
      const current = await store.readUser(id);
      if (!current) throw new Error("fixture user missing after committed charge");
      await store.writeUser({ ...current, passwordHash: "changed-hash", sessionEpoch: 2 });
      const changedPassword = await store.readUser(id);
      if (!changedPassword) throw new Error("fixture user missing after password write");
      await store.writeUser({ ...changedPassword, email: "changed-profile@example.com" });
      vi.resetModules();
      const restarted = await import("./ledger");
      expect.soft(await restarted.hasEntryFor(id, "charge", entry.ref)).toBe(true);
      await restarted.applyBalanceChange(id, -2, entry);
      expect.soft(JSON.parse(await fs.readFile(fault.userFile, "utf8"))).toMatchObject({
        balanceCny: 8, passwordHash: "changed-hash", sessionEpoch: 2,
        email: "changed-profile@example.com",
      });
      const rows = await diskRows(fs);
      expect(rows).toHaveLength(1);
      expect.soft(rows[0]).toMatchObject({ ...entry, balanceAfterCny: 8 });
    });
  });
});
