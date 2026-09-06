#!/usr/bin/env node
/**
 * 生成礼品码（自助充值码）。
 *
 *   node scripts/mint-gift-codes.mjs 10 20 --note "十一活动"
 *   （铸 10 张，每张 ¥20）
 *
 * 码只写进 data/gift-codes/<code>.json 并打印到标准输出，**不写日志**——
 * stdout 由管理员直接分发，别重定向进文件、别贴进聊天。一张码就是一笔钱。
 *
 * DATA_DIR 与服务端一致（不设时用 ./data）。字母表与 src/lib/users/schema.ts
 * 的 INVITE_ALPHABET 必须保持一致（.mjs 无法 import TypeScript）；记录形状与
 * giftCodeRecordSchema 一致，多写少写字段服务端读出来都会当成无效码。
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const MAX_AMOUNT = 100000;

function usage(message) {
  process.stderr.write(
    `${message}\n用法: node scripts/mint-gift-codes.mjs <数量> <面额元> [--note "说明"]\n`,
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const noteIndex = argv.indexOf("--note");
const note = noteIndex >= 0 ? argv[noteIndex + 1] : undefined;
if (noteIndex >= 0 && (note === undefined || note.startsWith("--"))) usage("--note 需要一个值");

const count = Number(positional[0] ?? "");
if (!Number.isInteger(count) || count < 1 || count > 500) usage("数量必须是 1–500 的整数");

const rawAmount = Number(positional[1] ?? "");
if (!Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount > MAX_AMOUNT) {
  usage(`面额必须是 0 到 ${MAX_AMOUNT} 之间的正数（人民币元）`);
}
// 服务端余额一律两位小数；这里先round好，免得码上写着 ¥9.999、到账 ¥10。
const amountCny = Math.round(rawAmount * 100) / 100;
if (amountCny <= 0) usage("面额四舍五入到分之后必须大于 0");

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const giftCodesDir = path.join(dataDir, "gift-codes");

function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** 与服务端同款：临时文件 + rename 原子替换。 */
async function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

await mkdir(giftCodesDir, { recursive: true });

const minted = [];
for (let i = 0; i < count; i += 1) {
  let code = generateCode();
  let attempts = 0;
  while (await exists(path.join(giftCodesDir, `${code}.json`))) {
    if (++attempts > 5) {
      process.stderr.write("生成礼品码失败：重复过多\n");
      process.exit(1);
    }
    code = generateCode();
  }
  await writeJsonAtomic(path.join(giftCodesDir, `${code}.json`), {
    code,
    amountCny,
    createdAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  });
  minted.push(code);
}

// 只有码本身进 stdout（每行一个），统计信息走 stderr。
process.stderr.write(
  `已生成 ${minted.length} 张礼品码，每张 ¥${amountCny} → ${giftCodesDir}${note ? `（备注：${note}）` : ""}\n`,
);
for (const code of minted) process.stdout.write(`${code}\n`);
