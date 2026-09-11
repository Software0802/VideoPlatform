import { z } from "zod";

const money = z.number().finite();
const pool = z.enum(["purchased", "member"]);
const kind = z.enum(["grant", "charge", "adjust"]);
const text = z.string().min(1);
export const poolsSchema = z.object({ balanceCny: money, memberCreditsCny: money.nonnegative() }).strict();
export const ledgerEntrySchema = z.object({
  at: z.string().datetime(), kind, amountCny: money, balanceAfterCny: money,
  jobId: text.optional(), giftCode: text.optional(), ref: text.optional(),
  memberCny: money.nonnegative().optional(), note: text.optional(),
}).strict();
const inputSchema = z.object({
  delta: money,
  entry: ledgerEntrySchema.omit({ at: true, balanceAfterCny: true, memberCny: true }),
  options: z.object({ pool: pool.optional() }).strict(),
}).strict();
export const baselineSchema = z.object({
  version: z.literal(1), userId: z.string().regex(/^usr_[0-9a-f]{16}$/),
  userSha256: z.string().regex(/^[0-9a-f]{64}$/), ledgerSha256: z.string().regex(/^[0-9a-f]{64}$/),
  reviewedBy: text, evidence: text, opening: poolsSchema,
  grantPools: z.record(z.string(), pool),
}).strict();
export const billingSchema = z.object({
  version: z.literal(1), legacyLedger: z.string(), opening: poolsSchema,
  operations: z.array(z.object({
    seq: z.number().int().positive(), operationId: z.string().uuid(), input: inputSchema,
    ledgerEntry: ledgerEntrySchema, before: poolsSchema, after: poolsSchema,
    effectivePool: z.enum(["purchased", "member", "auto"]),
  }).strict()),
  migration: baselineSchema.optional(),
}).strict();

export const managedUserSchema = z.object({
  id: z.string().regex(/^usr_[0-9a-f]{16}$/), email: z.string().min(3).max(254),
  passwordHash: text, sessionEpoch: z.number().int().min(1), plan: z.literal("free"),
  balanceCny: money.default(0), memberCreditsCny: money.nonnegative().default(0),
  subscription: z.object({
    id: z.string().regex(/^sub_[0-9a-f]{16}$/),
    planId: z.enum(["standard", "pro", "premium", "ultimate"]), cycle: z.enum(["monthly", "yearly"]),
    startedAt: z.string(), expiresAt: z.string(), periodIndex: z.number().int().nonnegative(),
    periodStartedAt: z.string(), lastDailyGrantOn: z.string().optional(),
  }).passthrough().optional(),
  disabled: z.boolean().optional(), inviteCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{12}$/).optional(),
  createdAt: z.string(), updatedAt: z.string(), billing: billingSchema.optional(),
}).passthrough();

export function validateUserRecord(value, userId) {
  const record = managedUserSchema.parse(value);
  if (record.id !== userId) throw billingError("billing_user_mismatch");
  if (record.billing !== undefined) validateSnapshot(record);
  return record;
}

export function billingError(code, message = code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(rounded) || !Number.isSafeInteger(Math.round(rounded * 100))) {
    throw billingError("billing_invalid_amount");
  }
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function splitAcrossPools(balanceCny, memberCreditsCny, delta, selectedPool) {
  const member = Number.isFinite(memberCreditsCny) ? Math.max(0, memberCreditsCny) : 0;
  if (delta >= 0) {
    return selectedPool === "member"
      ? { balanceCny: round2(balanceCny), memberCreditsCny: round2(member + delta), memberCny: 0 }
      : { balanceCny: round2(balanceCny + delta), memberCreditsCny: round2(member), memberCny: 0 };
  }
  const fromMember = selectedPool === "purchased" ? 0 : round2(Math.min(member, -delta));
  const fromPurchased = selectedPool === "member" ? 0 : round2(-delta - fromMember);
  return {
    balanceCny: round2(balanceCny - fromPurchased),
    memberCreditsCny: round2(member - fromMember), memberCny: fromMember,
  };
}

export function normalizeInput(input) {
  const entry = { ...input.entry };
  for (const key of ["jobId", "giftCode", "ref", "note"]) {
    if (entry[key] === "") delete entry[key];
  }
  const parsed = inputSchema.parse({ ...input, entry });
  const delta = round2(parsed.delta);
  const amountCny = round2(parsed.entry.amountCny);
  if (delta !== amountCny) throw billingError("billing_amount_mismatch");
  return { delta, entry: { ...parsed.entry, amountCny }, options: parsed.options };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function sameValue(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function balances(record) {
  return poolsSchema.parse({ balanceCny: record.balanceCny, memberCreditsCny: record.memberCreditsCny });
}

function keys(entry) {
  const result = [];
  if (entry.kind === "charge" && entry.jobId) result.push(JSON.stringify(["job", entry.jobId]));
  if (entry.kind === "grant" && entry.giftCode) result.push(JSON.stringify(["gift", entry.giftCode]));
  if (entry.ref) result.push(JSON.stringify(["ref", entry.kind, entry.ref]));
  return result;
}

export function parseLegacy(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = ledgerEntrySchema.parse(JSON.parse(line));
    for (const value of [row.amountCny, row.balanceAfterCny, row.memberCny ?? 0]) {
      if (round2(value) !== value) throw billingError("billing_legacy_precision");
    }
    rows.push(row);
  }
  assertUnique(rows);
  return rows;
}

function assertUnique(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const key of keys(row)) {
      if (seen.has(key)) throw billingError("billing_duplicate_key");
      seen.add(key);
    }
  }
}

export function emptyBilling(record) {
  return billingSchema.parse({ version: 1, legacyLedger: "", opening: balances(record), operations: [] });
}

export function validateSnapshot(record) {
  if (record.billing === undefined) throw billingError("billing_migration_required");
  const billing = billingSchema.parse(record.billing);
  const legacy = parseLegacy(billing.legacyLedger);
  if (billing.legacyLedger && !billing.migration) throw billingError("billing_missing_baseline");
  if (billing.migration) {
    if (billing.migration.userId !== record.id) throw billingError("billing_baseline_user");
    verifyLegacyBalances(legacy, billing.migration, billing.opening);
  }
  let current = billing.opening;
  const ids = new Set();
  const rows = [...legacy];
  for (const [index, op] of billing.operations.entries()) {
    if (op.seq !== index + 1 || ids.has(op.operationId)) throw billingError("billing_invalid_sequence");
    ids.add(op.operationId);
    const input = normalizeInput(op.input);
    if (!sameValue(input, op.input) || !sameValue(current, op.before)) throw billingError("billing_broken_chain");
    if (input.options.pool && op.effectivePool !== input.options.pool) throw billingError("billing_invalid_pool");
    if (input.delta >= 0 && op.effectivePool !== (input.options.pool ?? "purchased")) throw billingError("billing_invalid_pool");
    if (!input.options.pool && input.delta < 0 && op.effectivePool === "member") throw billingError("billing_invalid_pool");
    const split = splitAcrossPools(current.balanceCny, current.memberCreditsCny, input.delta,
      op.effectivePool === "auto" ? undefined : op.effectivePool);
    const after = balances(split);
    const row = makeEntry(input, op.ledgerEntry.at, split);
    if (!sameValue(after, op.after) || !sameValue(row, op.ledgerEntry)) throw billingError("billing_broken_chain");
    current = after;
    rows.push(row);
  }
  assertUnique(rows);
  if (!sameValue(current, balances(record))) throw billingError("billing_balance_mismatch");
  return billing;
}

function makeEntry(input, at, split) {
  return {
    at, ...input.entry, balanceAfterCny: split.balanceCny,
    ...(split.memberCny > 0 ? { memberCny: split.memberCny } : {}),
  };
}

export function snapshotRows(record) {
  const billing = validateSnapshot(record);
  return [...parseLegacy(billing.legacyLedger), ...billing.operations.map((op) => op.ledgerEntry)];
}

export function findOperation(record, entry) {
  const wanted = keys(entry);
  return snapshotRows(record).find((row) => keys(row).some((key) => wanted.includes(key)));
}

export function prepareChange(record, rawInput, context) {
  const billing = validateSnapshot(record);
  const input = normalizeInput(rawInput);
  const wanted = keys(input.entry);
  const matches = billing.operations.filter((op) => keys(op.input.entry).some((key) => wanted.includes(key)));
  const legacy = parseLegacy(billing.legacyLedger);
  const oldMatches = legacy.filter((row) => keys(row).some((key) => wanted.includes(key)));
  if (matches.length + oldMatches.length > 1) throw billingError("billing_idempotency_conflict");
  if (matches.length) {
    if (!sameValue(matches[0].input, input)) throw billingError("billing_idempotency_conflict");
    return record;
  }
  if (oldMatches.length) {
    const row = oldMatches[0];
    const { at, balanceAfterCny, memberCny, ...entry } = row;
    void at; void balanceAfterCny;
    const legacyPool = row.amountCny >= 0
      ? billing.migration?.grantPools[String(legacy.indexOf(row))]
      : (memberCny ?? 0) === 0 ? "purchased" : "auto";
    const requestedPool = input.options.pool ?? (input.delta >= 0 ? "purchased" : "auto");
    if (!sameValue(entry, input.entry) || input.delta !== row.amountCny ||
        (requestedPool !== legacyPool && !(requestedPool === "auto" && legacyPool === "purchased"))) {
      throw billingError("billing_idempotency_conflict");
    }
    return record;
  }
  const effectivePool = input.options.pool ?? (input.delta >= 0 ? "purchased"
    : Date.parse(record.subscription?.expiresAt ?? "") > Date.parse(context.at) ? "auto" : "purchased");
  const before = balances(record);
  const split = splitAcrossPools(before.balanceCny, before.memberCreditsCny, input.delta,
    effectivePool === "auto" ? undefined : effectivePool);
  const after = balances(split);
  const op = {
    seq: billing.operations.length + 1, operationId: context.operationId,
    input, ledgerEntry: makeEntry(input, context.at, split), before, after, effectivePool,
  };
  const next = { ...record, ...after, billing: { ...billing, operations: [...billing.operations, op] } };
  validateSnapshot(next);
  return next;
}

export function validateTransition(previous, next) {
  if (previous.billing === undefined) {
    if (next.billing !== undefined) throw billingError("billing_migration_required");
    if (!sameValue(balances(previous), balances(next))) throw billingError("billing_migration_required");
    return;
  }
  const old = validateSnapshot(previous);
  const current = validateSnapshot(next);
  if (!sameValue(old.opening, current.opening) || old.legacyLedger !== current.legacyLedger ||
      !sameValue(old.migration, current.migration) ||
      current.operations.length < old.operations.length || current.operations.length > old.operations.length + 1 ||
      !sameValue(old.operations, current.operations.slice(0, old.operations.length))) {
    throw billingError("billing_history_rewrite");
  }
}

export function verifyLegacyBalances(rows, baseline, expected) {
  let current = poolsSchema.parse(baseline.opening);
  if (!rows.length && (current.balanceCny !== 0 || current.memberCreditsCny !== 0 ||
      expected.balanceCny !== 0 || expected.memberCreditsCny !== 0)) throw billingError("billing_unproven_opening");
  const used = new Set();
  for (const [index, row] of rows.entries()) {
    let next;
    if (row.amountCny > 0) {
      const selected = baseline.grantPools[String(index)];
      if (!selected || (row.memberCny ?? 0) !== 0) throw billingError("billing_ambiguous_legacy_pool");
      used.add(String(index));
      next = splitAcrossPools(current.balanceCny, current.memberCreditsCny, row.amountCny, selected);
    } else {
      const member = row.memberCny ?? 0;
      if (member > -row.amountCny || member > current.memberCreditsCny) throw billingError("billing_invalid_legacy_member");
      next = {
        balanceCny: round2(current.balanceCny + row.amountCny + member),
        memberCreditsCny: round2(current.memberCreditsCny - member),
      };
    }
    if (next.balanceCny !== row.balanceAfterCny) throw billingError("billing_legacy_balance_mismatch");
    current = balances(next);
  }
  if (Object.keys(baseline.grantPools).some((key) => !used.has(key))) throw billingError("billing_unused_grant_pool");
  if (!sameValue(current, balances(expected))) throw billingError("billing_legacy_balance_mismatch");
  return current;
}
