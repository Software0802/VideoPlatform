#!/usr/bin/env node
// @ts-check
/**
 * 管理员重置密码（方案 §3.4「账号闭环」）。
 *
 *   node scripts/reset-password.mjs a@b.com
 *
 * 生成一个 12 位随机口令，写进 `data/users/<id>/user.json`（scrypt，与服务端逐字
 * 一致的散列格式），并把 `sessionEpoch` 加一——**该账号在所有设备上立刻掉线**，
 * 包括正拿着旧密码的那个人。
 *
 * 新口令只打印到 stdout（一行，不带任何前缀），统计信息走 stderr：
 * 直接读给用户听或用密码管理器接走，别重定向进文件、别贴进聊天。
 *
 * DATA_DIR 与服务端一致（不设时用 ./data）。
 */
import path from "node:path";
import process from "node:process";
import {
  bumpEpoch,
  findUserIdByEmail,
  generatePassword,
  hashPassword,
  resolveDataDir,
  requireOffline,
  updateUser,
  usage,
  usersDirOf,
  verifyPassword,
} from "./lib/users-store.mjs";

const HOWTO = "node scripts/reset-password.mjs <邮箱> --offline";

const argv = process.argv.slice(2);
requireOffline(argv, HOWTO);
const positional = argv.filter((a) => !a.startsWith("--"));
const email = String(positional[0] ?? "").trim().toLowerCase();
if (!email || !email.includes("@")) usage("第一个参数必须是邮箱", HOWTO);

const dataDir = resolveDataDir();
const usersDir = usersDirOf(dataDir);

const userId = await findUserIdByEmail(usersDir, email);
if (!userId) {
  process.stderr.write(`找不到账号: ${email}（DATA_DIR=${dataDir}）\n`);
  process.exit(1);
}

const password = generatePassword(12);
const passwordHash = await hashPassword(password);

// 先自检再落盘：散列格式是从 TS 抄过来的，抄错一个参数不会报错，只会写进一个服务端
// 永远验不过的散列，而管理员要等用户回来说「登不上」才知道。
if (!(await verifyPassword(password, passwordHash))) {
  process.stderr.write("散列自检失败，未改动任何文件（scrypt 参数与服务端不一致？）\n");
  process.exit(1);
}

const next = await updateUser(usersDir, userId, (user) => bumpEpoch({ ...user, passwordHash }));

process.stderr.write(
  `${email} 密码已重置（${path.join(usersDir, userId, "user.json")}）；` +
    `sessionEpoch ${next.sessionEpoch - 1} → ${next.sessionEpoch}，该账号所有设备已掉线。\n` +
    `下面这一行是新密码，只显示这一次：\n`,
);
process.stdout.write(`${password}\n`);
