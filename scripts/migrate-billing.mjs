#!/usr/bin/env node
// @ts-check
import path from "node:path";
import process from "node:process";
import { readText, migrateRecord, writeJsonAtomic } from "../src/lib/billing/file-ledger.mjs";
import { baselineSchema, validateUserRecord } from "../src/lib/billing/protocol.mjs";
import { optionValue, requireOffline, resolveDataDir, userFileOf, usersDirOf, usage } from "./lib/users-store.mjs";

const HOWTO = "node scripts/migrate-billing.mjs --offline --baseline <已核对基线.json>";
const argv = process.argv.slice(2);
requireOffline(argv, HOWTO);
const baselineFile = optionValue(argv, "--baseline", HOWTO);
if (!baselineFile || argv.length !== 3 || argv.filter((arg) => arg === "--baseline").length !== 1) {
  usage("必须提供唯一基线文件；不支持 --force 或跳过校验", HOWTO);
}
const baseline = baselineSchema.parse(JSON.parse(/** @type {string} */ (await readText(path.resolve(baselineFile)))));
const dataDir = resolveDataDir();
const userFile = userFileOf(usersDirOf(dataDir), baseline.userId);
const ledgerFile = path.join(dataDir, "ledger", `${baseline.userId}.jsonl`);
const userRaw = /** @type {string} */ (await readText(userFile));
const rawRecord = JSON.parse(userRaw);
const record = validateUserRecord(rawRecord, baseline.userId);
const ledgerRaw = (await readText(ledgerFile, true)) ?? "";
const migrated = migrateRecord(record, userRaw, ledgerRaw, baseline);
await writeJsonAtomic(userFile, { ...rawRecord, billing: migrated.billing });
process.stdout.write(`${baseline.userId} 资金快照已迁移；余额及旧流水原文保持不变。新格式不得自动回滚至不兼容旧版本。\n`);
