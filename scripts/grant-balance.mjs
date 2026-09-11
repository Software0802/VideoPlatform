#!/usr/bin/env node
/**
 * 管理员充值：给一个账号的余额加钱（负数就是扣钱 / 纠正）。
 *
 *   node scripts/grant-balance.mjs a@b.com 20 --note "内测赠送"
 *   node scripts/grant-balance.mjs a@b.com -5 --note "误充回收"
 *
 * DATA_DIR 与服务端一致（不设时用 ./data）。
 *
 * ⚠️ 落盘逻辑与 `src/lib/billing/ledger.ts` 的 `applyBalanceChange` 逐字一致
 * （.mjs 无法 import TypeScript）：读 user.json → 改 balanceCny → 临时文件 + rename
 * 原子替换 → 往 data/ledger/<userId>.jsonl 追加一行同样字段、同样顺序的 JSON。
 * 改动任何一边都必须同步改另一边。
 *
 * ⚠️ 只动**已购池** `balanceCny`（等价于服务端的 `pool: "purchased"`）。订阅送的
 * `memberCreditsCny` 是另一个池，期末由 `settleSubscription` 清零，管理员不该手工改它——
 * 要补偿就充已购池。整份记录是展开写回去的（`{ ...user, balanceCny }`），所以
 * `memberCreditsCny` / `subscription` 这些本脚本不认识的字段原样保留，不会被抹掉。
 *
 * ⚠️ 已知限制：本 CLI 与线上服务之间**没有跨进程锁**。服务端的 `withUserLock` 只在
 * 那个进程内串行，管不到这个脚本；两边都是「读 user.json → 改 balanceCny → 原子
 * 替换」，所以充值的同一瞬间若恰好发生同一用户的扣款（任务成功结算）或改密，后写的
 * 那次会把先写的整份记录覆盖掉，丢一次写——余额少扣 / 少充，或者新密码被回退，而
 * ledger 里两行都在（流水是只增的，不会丢）。
 * 缓解办法就是错开时间：充值前后各看一眼 `data/ledger/<userId>.jsonl` 的最后几行与
 * `user.json` 的 `balanceCny`，确认 `balanceAfterCny` 与余额对得上；对不上按流水重算
 * 余额、再用本脚本以 `adjust` 语义的金额补正。内测规模下「跑之前看一眼没人在用」
 * 就够了，不值得为它引入文件锁。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { commitChange, readText, writeJsonAtomic as writeShared } from "../src/lib/billing/file-ledger.mjs";
import { validateUserRecord, validateTransition } from "../src/lib/billing/protocol.mjs";
import { requireOffline } from "./lib/users-store.mjs";

const USER_ID_RE = /^usr_[0-9a-f]{16}$/;

function usage(message) {
  process.stderr.write(
    `${message}\n用法: node scripts/grant-balance.mjs <邮箱> <金额（元，可为负）> --offline [--ref "同笔操作固定键"] [--note "说明"]\n无 --ref 时每次调用均新增一笔，不能安全重跑未知结果的充值。\n`,
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
requireOffline(argv, "node scripts/grant-balance.mjs <邮箱> <金额> --offline [--ref 固定键] [--note 说明]");
const positional = [];
const options = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--offline") continue;
  if (arg === "--note" || arg === "--ref") {
    const value = argv[++i];
    if (!value || value.startsWith("--") || options[arg] !== undefined) usage(`${arg} 需要唯一的非空值`);
    options[arg] = value;
  } else if (arg.startsWith("--")) usage(`未知参数: ${arg}`);
  else positional.push(arg);
}
if (positional.length !== 2) usage("需要邮箱与金额两个位置参数");
const note = options["--note"];
const ref = options["--ref"];
if (!ref) process.stderr.write("警告：未提供 --ref，本次调用新增一笔；结果不明时不要直接重跑。\n");

const email = String(positional[0] ?? "").trim().toLowerCase();
if (!email || !email.includes("@")) usage("第一个参数必须是邮箱");

// 负号开头的金额会被上面的 filter 当成普通参数留下（`--` 才是选项），所以直接取第二个。
const amount = Number(positional[1]);
if (!Number.isFinite(amount) || amount === 0) usage("金额必须是非 0 的数字（元）");

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const usersDir = path.join(dataDir, "users");
const ledgerDir = path.join(dataDir, "ledger");

/** 与服务端同款：临时文件 + rename 原子替换。 */
async function writeJsonAtomic(destination, value) {
  await writeShared(destination, value);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * index.json 只是派生缓存（服务端会自愈），所以它没命中时照样扫一遍目录——
 * 充值失败的正确原因只能是「这个人真的没注册」。
 */
async function findUserId() {
  const index = await readJson(path.join(usersDir, "index.json"));
  const indexed = index && typeof index === "object" ? index[email] : undefined;
  if (typeof indexed === "string" && USER_ID_RE.test(indexed)) return indexed;

  let names = [];
  try {
    names = await readdir(usersDir);
  } catch {
    usage(`找不到用户目录: ${usersDir}（DATA_DIR 是不是没对上？）`);
  }
  const hits = [];
  for (const name of names.filter((n) => USER_ID_RE.test(n))) {
    const user = await readJson(path.join(usersDir, name, "user.json"));
    if (user && String(user.email ?? "").trim().toLowerCase() === email) hits.push(user);
  }
  if (!hits.length) return null;
  // 与服务端 buildFromDisk 同一个判据：万一两条记录抢同一个邮箱，最早创建的算数。
  hits.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return hits[0].id;
}

const userId = await findUserId();
if (!userId) {
  process.stderr.write(`找不到账号: ${email}\n`);
  process.exit(1);
}

const userFile = path.join(usersDir, userId, "user.json");
const user = validateUserRecord(JSON.parse(await readText(userFile)), userId);
if (user.email !== email) throw new Error("用户索引与邮箱不一致，请离线核对");
const before = user.balanceCny;

// 字段与顺序跟 ledger.ts 一模一样；kind 固定 grant（负数的人工纠正也记 grant 的反向额）。
const next = await commitChange(user, {
  delta: amount,
  entry: { kind: "grant", amountCny: amount, ...(note ? { note } : {}), ...(ref ? { ref } : {}) },
  options: { pool: "purchased" },
}, {
  ledgerFile: path.join(ledgerDir, `${userId}.jsonl`),
  write: async (record) => {
    const written = validateUserRecord({ ...record, updatedAt: new Date().toISOString() }, userId);
    validateTransition(user, written);
    await writeJsonAtomic(userFile, written);
    return written;
  },
});
const after = next.balanceCny;

process.stdout.write(`${email} 余额: ¥${before.toFixed(2)} → ¥${after.toFixed(2)}\n`);
