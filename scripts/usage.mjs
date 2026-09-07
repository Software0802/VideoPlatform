#!/usr/bin/env node
/**
 * 用量与账目汇总（方案 §3.4「管理闭环」）。
 *
 *   node scripts/usage.mjs
 *   node scripts/usage.mjs --day 2026-09-06
 *   node scripts/usage.mjs --user a@b.com
 *
 * 扫 `data/jobs/&#42;/job.json` 与 `data/ledger/&#42;.jsonl`，按天 / 按用户 / 按 provider 打三张表：
 * 任务数、成功率、售价合计（`priceCny`，我们向用户收的钱）、上游成本合计
 * （`costUsdActual`，我们向供应商付的钱）。最后一张表拿流水与任务侧对一次账。
 *
 * 三条口径，看数之前先读一遍：
 *
 * 1. **只统计终态任务**，按「结算日」归日 —— `completedAt ?? updatedAt`，时区
 *    Asia/Shanghai，与 `src/lib/jobs/quota.ts` 完全一致。23:59 提交、次日 00:05 出片的
 *    任务算次日，否则它会两天都不算。在途任务不进任何一天，单独报一个总数。
 * 2. **售价只算成功的任务**。失败 / 取消 / 过期不计费是产品纪律（`store.updateJob` 只在
 *    成功那一刻扣款），把它们的 `priceCny` 加进来就是虚报收入。
 * 3. **成本算所有终态任务**。被上游拒掉之前可能已经付过钱，那笔钱是真花了的。
 *    `costUsdActual` 缺失（上游没回用量）的条数单独列出来——它是「这张表少算了多少」
 *    的上界，不能当成 0 就算了。
 *
 * DATA_DIR 与服务端一致（不设时用 ./data）。只读，不写任何文件。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  listUsers,
  normalizeEmail,
  optionValue,
  readJson,
  resolveDataDir,
  usage as usageError,
  usersDirOf,
} from "./lib/users-store.mjs";

const HOWTO = 'node scripts/usage.mjs [--day YYYY-MM-DD] [--user 邮箱]';

const argv = process.argv.slice(2);
const day = optionValue(argv, "--day", HOWTO);
const userFilter = optionValue(argv, "--user", HOWTO);
if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) usageError("--day 必须是 YYYY-MM-DD", HOWTO);

const dataDir = resolveDataDir();
const usersDir = usersDirOf(dataDir);
const jobsDir = path.join(dataDir, "jobs");
const ledgerDir = path.join(dataDir, "ledger");

/* ── 归日：与服务端 quota.ts 同一个时区，同一个「结算日」定义 ── */

const DAY_ZONE = "Asia/Shanghai";
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: DAY_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ISO 时刻 → `YYYY-MM-DD`（Asia/Shanghai）。认不出来的时刻回 null。 */
function dayKey(iso) {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? dayFormat.format(new Date(ms)) : null;
}

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired"]);

/* ── 读盘 ── */

const users = await listUsers(usersDir);
const emailOf = new Map(users.map((u) => [u.id, u.email]));
const balanceOf = new Map(users.map((u) => [u.id, Number(u.balanceCny) || 0]));

let wantedOwner;
if (userFilter !== undefined) {
  const wanted = normalizeEmail(userFilter);
  const hit = users.find((u) => normalizeEmail(u.email) === wanted);
  if (!hit) {
    process.stderr.write(`找不到账号: ${wanted}（DATA_DIR=${dataDir}）\n`);
    process.exit(1);
  }
  wantedOwner = hit.id;
}

async function readJobs() {
  let entries = [];
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    // 目录树里除了任务目录还有 index.json 这类派生文件，按「有没有 job.json」判断，
    // 不猜 id 的形状——id 规则变了这里不该跟着坏。
    if (!entry.isDirectory()) continue;
    const rec = await readJson(path.join(jobsDir, entry.name, "job.json"));
    if (rec && typeof rec.status === "string") out.push(rec);
  }
  return out;
}

const allJobs = await readJobs();

/* ── 分桶 ── */

function emptyBucket() {
  return { total: 0, succeeded: 0, failed: 0, canceled: 0, expired: 0, cny: 0, usd: 0, unknownCost: 0 };
}

function add(map, key, job) {
  const bucket = map.get(key) ?? emptyBucket();
  bucket.total += 1;
  if (job.status === "succeeded") {
    bucket.succeeded += 1;
    bucket.cny += Number(job.priceCny) || 0;
  } else if (job.status === "failed") bucket.failed += 1;
  else if (job.status === "canceled") bucket.canceled += 1;
  else if (job.status === "expired") bucket.expired += 1;
  // `costUsdActual` 缺失时字段是 `null`（上游没回用量），而 `Number(null)` 是 0——照
  // `Number.isFinite` 判就成了「成本 0，且不算缺」，两头都错：成本被低估，「缺成本」这
  // 一列还显示 0，看表的人以为这张表是全的。只认真正的数字，其余（null / undefined /
  // 手工编辑出来的字符串）一律计入 unknownCost。
  const cost = typeof job.costUsdActual === "number" ? job.costUsdActual : Number.NaN;
  if (Number.isFinite(cost)) bucket.usd += cost;
  else bucket.unknownCost += 1;
  map.set(key, bucket);
  return bucket;
}

const byDay = new Map();
const byUser = new Map();
const byProvider = new Map();
const totals = new Map();
let inFlight = 0;
let skippedOwner = 0;
let skippedDay = 0;

for (const job of allJobs) {
  if (wantedOwner !== undefined && job.ownerId !== wantedOwner) {
    skippedOwner += 1;
    continue;
  }
  if (!TERMINAL.has(job.status)) {
    inFlight += 1;
    continue;
  }
  const key = dayKey(job.completedAt ?? job.updatedAt);
  if (day !== undefined && key !== day) {
    skippedDay += 1;
    continue;
  }
  add(byDay, key ?? "(时间不明)", job);
  add(byUser, emailOf.get(job.ownerId) ?? (job.ownerId ? `(已删账号 ${job.ownerId})` : "(无主任务)"), job);
  add(byProvider, job.provider ?? "(未知)", job);
  add(totals, "总计", job);
}

const overall = totals.get("总计") ?? emptyBucket();

/* ── 流水 ── */

async function readLedger(userId) {
  let raw;
  try {
    raw = await readFile(path.join(ledgerDir, `${userId}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") rows.push(parsed);
    } catch {
      // 半截写入 / 手工编辑：跳过坏行，与服务端 `readLedgerRows` 同一条纪律。
    }
  }
  return rows;
}

/**
 * 一行流水归到哪一列。
 *
 * 2026-09-06 起流水里多了两类**与任务无关**的行（订阅、智能体），它们和「任务侧售价」
 * 是两笔生意，混在一起会让最后那条对账永远对不上：
 *
 *  · `charge` 带 `ref`、没有 `jobId` → 订阅费（`sub:*`）或智能体轮次费（`agent:*`）。
 *    它们不对应任何一条任务，绝不能进「任务侧扣款」那一列。
 *  · `grant` 的 `ref` 以 `sub:` 开头 → 订阅送的会员积分（进会员池，`pool:"member"`）。
 *    那不是充值，把它算进「充值」等于把我们自己发的券当成收入。
 */
function ledgerColumn(row) {
  if (row.kind === "grant") return String(row.ref ?? "").startsWith("sub:") ? "member" : "grant";
  if (row.kind === "charge") return !row.jobId && row.ref ? "nonJob" : "charge";
  if (row.kind === "adjust") return "adjust";
  return null;
}

const ledgerRows = [];
for (const user of users) {
  if (wantedOwner !== undefined && user.id !== wantedOwner) continue;
  const rows = await readLedger(user.id);
  const sums = { grant: 0, member: 0, charge: 0, nonJob: 0, adjust: 0 };
  let counted = 0;
  for (const row of rows) {
    const at = dayKey(row.at);
    if (day !== undefined && at !== day) continue;
    const column = ledgerColumn(row);
    if (column) sums[column] += Number(row.amountCny) || 0;
    counted += 1;
  }
  if (counted === 0 && rows.length === 0) continue;
  ledgerRows.push({
    email: user.email,
    rows: counted,
    ...sums,
    balance: balanceOf.get(user.id) ?? 0,
  });
}

/* ── 打印 ── */

/** 终端里 CJK 是双宽，`padEnd` 只数码点，直接用会把表格排歪。 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

function pad(text, width, align) {
  const filler = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? filler + text : text + filler;
}

function table(title, headers, rows) {
  process.stdout.write(`\n${title}\n`);
  if (!rows.length) {
    process.stdout.write("  （无数据）\n");
    return;
  }
  const aligns = headers.map((_, i) => (i === 0 ? "left" : "right"));
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((row) => displayWidth(row[i]))),
  );
  const line = (cells) => `  ${cells.map((c, i) => pad(c, widths[i], aligns[i])).join("  ")}\n`;
  process.stdout.write(line(headers));
  process.stdout.write(`  ${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(line(row));
}

const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const rate = (b) => (b.total ? `${((b.succeeded / b.total) * 100).toFixed(1)}%` : "—");

const headersFor = (first) => [first, "任务", "成功", "失败", "取消", "过期", "成功率", "售价¥", "成本$", "缺成本"];

function toRow(key, b) {
  return [
    key,
    String(b.total),
    String(b.succeeded),
    String(b.failed),
    String(b.canceled),
    String(b.expired),
    rate(b),
    money(b.cny),
    money(b.usd),
    String(b.unknownCost),
  ];
}

function sortedRows(map, descending) {
  const keys = [...map.keys()].sort();
  if (descending) keys.reverse();
  return keys.map((key) => toRow(key, map.get(key)));
}

const scope = [
  day !== undefined ? `日期 ${day}（${DAY_ZONE}）` : "全部日期",
  userFilter !== undefined ? `账号 ${normalizeEmail(userFilter)}` : "全部账号",
].join(" · ");

process.stdout.write(`用量汇总  DATA_DIR=${dataDir}\n范围: ${scope}\n`);
process.stdout.write(
  `扫描 ${allJobs.length} 条任务：统计 ${overall.total} 条终态` +
    `，在途 ${inFlight} 条（不计入下表）` +
    (skippedOwner ? `，其他账号 ${skippedOwner} 条` : "") +
    (skippedDay ? `，其他日期 ${skippedDay} 条` : "") +
    `\n`,
);

table("按天（结算日）", headersFor("日期"), sortedRows(byDay, true));
table("按用户", headersFor("账号"), sortedRows(byUser, false));
table("按 provider", headersFor("provider"), sortedRows(byProvider, false));
table("合计", headersFor(""), [toRow("总计", overall)]);

table(
  "流水核对（data/ledger）",
  ["账号", "流水行", "充值¥", "会员发放¥", "任务扣款¥", "订阅/智能体¥", "纠正¥", "当前余额¥"],
  ledgerRows
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((r) => [
      r.email,
      String(r.rows),
      money(r.grant),
      money(r.member),
      money(r.charge),
      money(r.nonJob),
      money(r.adjust),
      money(r.balance),
    ]),
);

// 任务侧「成功任务售价之和」应当等于流水侧**任务扣款**的绝对值（扣款记负数）。订阅费与
// 智能体轮次费不在这条等式里：它们没有对应的任务，算进来只会让差额恒不为零，把这条
// 唯一能自动发现「钱少扣了」的线索变成噪音。对不上仍不算错误——补扣可能还挂着、或者
// 有手工纠正——但它现在真的只反映任务侧。
const chargedFromLedger = ledgerRows.reduce((sum, r) => sum + r.charge, 0);
const nonJobCharged = ledgerRows.reduce((sum, r) => sum + r.nonJob, 0);
const memberGranted = ledgerRows.reduce((sum, r) => sum + r.member, 0);
const diff = Math.round((overall.cny + chargedFromLedger) * 100) / 100;
process.stdout.write(
  `\n对账: 任务侧已计费 ¥${money(overall.cny)} vs 流水侧任务扣款 ¥${money(-chargedFromLedger)}` +
    (diff === 0 ? "（一致）" : `（差 ¥${money(diff)}，请核对补扣与人工纠正）`) +
    "\n",
);
process.stdout.write(
  `不参与上式: 订阅 / 智能体扣款 ¥${money(-nonJobCharged)}` +
    `，会员积分发放 ¥${money(memberGranted)}（进会员池，不是充值）\n`,
);
