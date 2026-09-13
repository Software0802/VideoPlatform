#!/usr/bin/env node
// @ts-check
/**
 * 告警渠道上线验证（R7）：向 `ALERT_WEBHOOK_URL` 指向的机器人/通用 webhook
 * 真实发一条 `test` 事件——走 `POST /api/admin/alerts/test`（LUMEN_ADMIN_TOKEN，
 * 见 `scripts/lib/admin-client.mjs`），服务必须在跑。
 *
 *   sudo -u genius node scripts/alert-test.mjs --note "上线验证"
 *
 * 退出码：sent=true → 0；sent=false（未配 URL / 去重 / 对端非 2xx / 网络异常）→ 1。
 * 注意去重窗口 10 分钟——同一 `test` dedupeKey 带时间戳不冲突，但对端若开了
 * 自定义关键词，文案首行是 `[Lumen]`（钉钉关键词填 `Lumen`）。
 */
import process from "node:process";
import { adminPost, splitAdminArgs } from "./lib/admin-client.mjs";

/** @param {string} message */
function usage(message) {
  process.stderr.write(
    `${message}\n用法: node scripts/alert-test.mjs [--note "说明"] [--env-file <路径>]\n`,
  );
  process.exit(1);
}

const { envFile, argv } = splitAdminArgs(process.argv.slice(2));
const noteIndex = argv.indexOf("--note");
const note = noteIndex >= 0 ? argv[noteIndex + 1] : undefined;
if (noteIndex >= 0 && (note === undefined || note.startsWith("--"))) usage("--note 需要一个值");
for (const arg of argv) {
  if (arg.startsWith("--") && arg !== "--note") usage(`未知参数 ${arg}`);
}

const data = await adminPost(envFile, "/api/admin/alerts/test", note ? { note } : {});
process.stderr.write(`format=${data.format} sent=${data.sent}\n`);
if (!data.sent) {
  process.stderr.write(
    "告警未发出：检查 ALERT_WEBHOOK_URL / ALERT_WEBHOOK_FORMAT / ALERT_WEBHOOK_SECRET，并看服务日志里的 warn\n",
  );
  process.exit(1);
}
