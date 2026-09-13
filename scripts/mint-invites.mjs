#!/usr/bin/env node
// @ts-check
/**
 * 生成一次性邀请码。
 *
 *   node scripts/mint-invites.mjs 10 --note "第一批内测"
 *
 * 码只写进 data/invites/<code>.json 并打印到标准输出，**不写日志**——
 * stdout 由管理员直接分发，别重定向进文件、别贴进聊天。
 *
 * DATA_DIR 与服务端一致（不设时用 ./data）。字母表与 src/lib/users/schema.ts
 * 的 INVITE_ALPHABET 必须保持一致（.mjs 无法 import TypeScript）。
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

/** @param {string} message */
function usage(message) {
  process.stderr.write(`${message}\n用法: node scripts/mint-invites.mjs <数量> [--note "说明"]\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const noteIndex = argv.indexOf("--note");
const note = noteIndex >= 0 ? argv[noteIndex + 1] : undefined;
if (noteIndex >= 0 && (note === undefined || note.startsWith("--"))) usage("--note 需要一个值");

const count = Number(positional[0] ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 500) usage("数量必须是 1–500 的整数");

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const invitesDir = path.join(dataDir, "invites");

function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

/** @param {string} file */
async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

/**
 * 与服务端同款：临时文件 + rename 原子替换。
 * @param {string} destination
 * @param {unknown} value
 */
async function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

await mkdir(invitesDir, { recursive: true });

const minted = [];
for (let i = 0; i < count; i += 1) {
  let code = generateCode();
  let attempts = 0;
  while (await exists(path.join(invitesDir, `${code}.json`))) {
    if (++attempts > 5) {
      process.stderr.write("生成邀请码失败：重复过多\n");
      process.exit(1);
    }
    code = generateCode();
  }
  await writeJsonAtomic(path.join(invitesDir, `${code}.json`), {
    code,
    createdAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  });
  minted.push(code);
}

// 只有码本身进 stdout（每行一个），统计信息走 stderr。
process.stderr.write(`已生成 ${minted.length} 个邀请码 → ${invitesDir}${note ? `（备注：${note}）` : ""}\n`);
for (const code of minted) process.stdout.write(`${code}\n`);
