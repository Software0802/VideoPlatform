#!/usr/bin/env node
// @ts-check
/**
 * 停用 / 恢复一个账号（方案 §3.4「管理闭环」）。
 *
 *   node scripts/disable-user.mjs a@b.com            # 停用
 *   node scripts/disable-user.mjs a@b.com --enable   # 恢复
 *
 * 停用 = `user.json` 写 `disabled: true` 并把 `sessionEpoch` 加一。两件事缺一不可：
 * `disabled` 让登录被拒（403 `account_disabled`），`sessionEpoch` 让**已经在用**的会话
 * 立刻失效——只写前者的话，那个人手里的 Cookie 还能继续跑任务花钱。
 *
 * 恢复时同样加一次 epoch：停用期间那几张旧 Cookie 不该因为恢复而复活。
 *
 * 停用不删任何数据、不动任何任务：在途任务照常跑完（钱已经花出去了），产物照常保留。
 *
 * DATA_DIR 与服务端一致（不设时用 ./data）。
 */
import { access } from "node:fs/promises";
import process from "node:process";
import {
  USER_ID_RE,
  bumpEpoch,
  findUserIdByEmail,
  resolveDataDir,
  updateUser,
  usage,
  userFileOf,
  usersDirOf,
} from "./lib/users-store.mjs";
import { adminPost, assertServiceStopped, splitAdminArgs } from "./lib/admin-client.mjs";

const HOWTO = "node scripts/disable-user.mjs <邮箱|usr_id> [--enable] [--offline] [--env-file <路径>]";

const { envFile, argv } = splitAdminArgs(process.argv.slice(2));
const offline = argv.includes("--offline");
const positional = argv.filter((a) => !a.startsWith("--"));
const enable = argv.includes("--enable");
const email = String(positional[0] ?? "").trim().toLowerCase();
if (!email || (!email.includes("@") && !USER_ID_RE.test(email))) {
  usage("第一个参数必须是邮箱或 usr_ 开头的用户 id", HOWTO);
}

if (!offline) {
  const data = await adminPost(envFile, `/api/admin/users/${encodeURIComponent(email)}/disabled`, {
    disabled: !enable,
  });
  const verb = enable ? "已恢复" : "已停用";
  process.stdout.write(
    `${email} ${verb}${data.noop ? "（此前就是这个状态）" : ""}；` +
      `sessionEpoch ${data.sessionEpoch - 1} → ${data.sessionEpoch}，该账号所有设备已掉线。\n`,
  );
  process.exit(0);
}
await assertServiceStopped();

const dataDir = resolveDataDir();
const usersDir = usersDirOf(dataDir);

const userId = USER_ID_RE.test(email) ? email : await findUserIdByEmail(usersDir, email);
const exists = userId
  ? await access(userFileOf(usersDir, userId)).then(() => true, () => false)
  : false;
if (!userId || !exists) {
  process.stderr.write(`找不到账号: ${email}（DATA_DIR=${dataDir}）\n`);
  process.exit(1);
}

let wasDisabled = false;
const next = await updateUser(usersDir, userId, (user) => {
  wasDisabled = user.disabled === true;
  const updated = bumpEpoch(user);
  // 恢复时**删掉**字段而不是写 false：schema 里它是可选的，留一个 `disabled: false`
  // 只会让人下次读记录时多想一秒「这是被停用过还是从来没有」。
  if (enable) delete updated.disabled;
  else updated.disabled = true;
  return updated;
});

const verb = enable ? "已恢复" : "已停用";
const noop = enable ? !wasDisabled : wasDisabled;
process.stdout.write(
  `${email} ${verb}${noop ? "（此前就是这个状态）" : ""}；` +
    `sessionEpoch ${next.sessionEpoch - 1} → ${next.sessionEpoch}，该账号所有设备已掉线。\n`,
);
