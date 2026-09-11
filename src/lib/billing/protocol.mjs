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
  /**
   * 订单快照（R04）：订阅购买的 charge 行带上「当初买的是什么档、什么周期、多少钱、
   * 什么时候下的单」。崩溃补建按这份快照履约——不按当前价目重算，也不许同 key
   * 换参数补建另一档。
   */
  order: z.object({
    planId: text, cycle: z.enum(["monthly", "yearly"]),
    priceCny: money.positive(), orderedAt: z.string().datetime(),
  }).strict().optional(),
}).strict();
const inputSchema = z.object({
  delta: money,
  entry: ledgerEntrySchema.omit({ at: true, balanceAfterCny: true, memberCny: true }),
  options: z.object({
    pool: pool.optional(),
    /**
     * 退款语义（R02）：正 delta 时指向原扣款行的 `ref`，按那笔 charge 的 `memberCny`
     * 把退款原路拆回——会员池出的部分退回会员池（哪怕订阅已过期、等着被结算清掉，
     * 也不许转成永久已购余额），其余进已购池。与 `pool` 互斥。
     */
    refundOf: text.optional(),
    /**
     * 会员池抽取上限（Reservation earmark）：负 delta 时最多从会员池出这么多。
     * 任务的预留分配在准入那一刻冻结；不封顶的话「会员池优先」扣款会动到别的
     * 在途任务 earmark 留在池里的钱，破坏「会员池余额 ≥ Σ 在途 earmark」不变量。
     * 与 `pool` / `refundOf` 互斥，且只允许负 delta。
     */
    memberMaxCny: money.nonnegative().optional(),
  }).strict(),
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
    effectivePool: z.enum(["purchased", "member", "auto", "refund"]),
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

export function splitAcrossPools(balanceCny, memberCreditsCny, delta, selectedPool, memberMaxCny) {
  const member = Number.isFinite(memberCreditsCny) ? Math.max(0, memberCreditsCny) : 0;
  if (delta >= 0) {
    return selectedPool === "member"
      ? { balanceCny: round2(balanceCny), memberCreditsCny: round2(member + delta), memberCny: 0 }
      : { balanceCny: round2(balanceCny + delta), memberCreditsCny: round2(member), memberCny: 0 };
  }
  const memberCap = memberMaxCny === undefined ? -delta : Math.min(-delta, memberMaxCny);
  const fromMember = selectedPool === "purchased" ? 0 : round2(Math.min(member, memberCap));
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
  if (parsed.options.refundOf !== undefined && (parsed.options.pool !== undefined || delta <= 0)) {
    throw billingError("billing_invalid_refund");
  }
  if (parsed.options.memberMaxCny !== undefined &&
      (parsed.options.pool !== undefined || parsed.options.refundOf !== undefined || delta >= 0)) {
    throw billingError("billing_invalid_member_cap");
  }
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

/**
 * 退款的拆池：沿 `refundOf` 找到原扣款行（它在链上必在当前 op 之前，所以只搜
 * 已重放的行集），把 `delta` 中不超过原扣款 `memberCny` 的部分退回会员池，其余进
 * 已购池。返回值与 `splitAcrossPools` 同形：`memberCny` 在一笔**正**向行上表示
 * 「退回会员池的金额」。原扣款找不到就失败关闭——乱猜池子等于免费送已购余额。
 */
function refundSplit(rows, refundOf, current, delta) {
  const source = rows.find((row) => row.kind === "charge" && row.ref === refundOf);
  if (!source) throw billingError("billing_refund_source_missing");
  const memberPart = round2(Math.min(Math.max(0, source.memberCny ?? 0), delta));
  return {
    balanceCny: round2(current.balanceCny + delta - memberPart),
    memberCreditsCny: round2(current.memberCreditsCny + memberPart),
    memberCny: memberPart,
  };
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
    if (input.options.refundOf) {
      if (op.effectivePool !== "refund") throw billingError("billing_invalid_pool");
    } else {
      if (input.options.pool && op.effectivePool !== input.options.pool) throw billingError("billing_invalid_pool");
      if (input.delta >= 0 && op.effectivePool !== (input.options.pool ?? "purchased")) throw billingError("billing_invalid_pool");
      if (!input.options.pool && input.delta < 0 && !["auto", "purchased"].includes(op.effectivePool)) {
        throw billingError("billing_invalid_pool");
      }
    }
    const split = input.options.refundOf
      ? refundSplit(rows, input.options.refundOf, current, input.delta)
      : splitAcrossPools(current.balanceCny, current.memberCreditsCny, input.delta,
        op.effectivePool === "auto" ? undefined : op.effectivePool, input.options.memberMaxCny);
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
  const effectivePool = input.options.refundOf ? "refund"
    // earmark 的会员份额不因订阅到期而失效（预留时就承诺了它走会员池），
    // 所以带 memberMaxCny 的扣款恒为 auto，不做「到期整笔落已购池」的退化。
    : input.options.memberMaxCny !== undefined ? "auto"
    : input.options.pool ?? (input.delta >= 0 ? "purchased"
    : Date.parse(record.subscription?.expiresAt ?? "") > Date.parse(context.at) ? "auto" : "purchased");
  const before = balances(record);
  const rows = [...legacy, ...billing.operations.map((op) => op.ledgerEntry)];
  const split = input.options.refundOf
    ? refundSplit(rows, input.options.refundOf, before, input.delta)
    : splitAcrossPools(before.balanceCny, before.memberCreditsCny, input.delta,
      effectivePool === "auto" ? undefined : effectivePool, input.options.memberMaxCny);
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
