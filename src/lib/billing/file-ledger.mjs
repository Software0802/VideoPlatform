import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { baselineSchema, billingError, emptyBilling, parseLegacy, prepareChange,
  validateSnapshot, verifyLegacyBalances } from "./protocol.mjs";

export async function readText(file, allowMissing = false) {
  try {
    const bytes = await readFile(file);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTextAtomic(destination, text) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, destination);
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 160)));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeJsonAtomic(destination, value) {
  await writeTextAtomic(destination, JSON.stringify(value, null, 2));
}

export function exportText(record) {
  const billing = validateSnapshot(record);
  if (billing.migration && createHash("sha256").update(billing.legacyLedger, "utf8").digest("hex") !== billing.migration.ledgerSha256) {
    throw billingError("billing_legacy_digest_mismatch");
  }
  const suffix = billing.operations.map((op) => JSON.stringify(op.ledgerEntry) + "\n").join("");
  const legacy = billing.legacyLedger;
  return legacy + (legacy && suffix && !legacy.endsWith("\n") ? "\n" : "") + suffix;
}

export async function checkExport(record, file) {
  const expected = exportText(record);
  const actual = await readText(file, true);
  if (actual !== null && actual !== expected &&
      !(expected.startsWith(actual) && (actual === "" || actual.endsWith("\n") || actual === record.billing.legacyLedger))) {
    throw billingError("billing_export_corrupt");
  }
  return { expected, actual };
}

export async function rebuildExport(record, file) {
  const { expected, actual } = await checkExport(record, file);
  if (actual !== expected) await writeTextAtomic(file, expected);
}

export async function commitChange(record, input, context) {
  validateSnapshot(record);
  await checkExport(record, context.ledgerFile);
  const next = prepareChange(record, input, {
    at: (context.now ?? (() => new Date().toISOString()))(),
    operationId: (context.newId ?? randomUUID)(),
  });
  const written = next === record ? record : await context.write(next);
  if (context.exportLedger) await context.exportLedger(written);
  else await rebuildExport(written, context.ledgerFile);
  return written;
}

export function migrateRecord(record, userRaw, ledgerRaw, baselineInput) {
  if (record.billing !== undefined) throw billingError("billing_already_migrated");
  const baseline = baselineSchema.parse(baselineInput);
  const sha256 = (raw) => createHash("sha256").update(raw, "utf8").digest("hex");
  if (baseline.userId !== record.id || baseline.userSha256 !== sha256(userRaw) ||
      baseline.ledgerSha256 !== sha256(ledgerRaw)) throw billingError("billing_baseline_mismatch");
  const rows = parseLegacy(ledgerRaw);
  verifyLegacyBalances(rows, baseline, record);
  const next = { ...record, billing: { ...emptyBilling(record), legacyLedger: ledgerRaw, migration: baseline } };
  validateSnapshot(next);
  return next;
}
