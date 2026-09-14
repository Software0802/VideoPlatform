#!/usr/bin/env node
// @ts-check
/**
 * 恢复核对（R4.0）：解包一份 `backup.sh` 产物（.tgz 或 .enc），打印摘要，
 * 可选与 DATA_DIR 逐项对账。
 *
 *   node scripts/restore-check.mjs --archive backups/genius-data-XXX.tgz
 *   node scripts/restore-check.mjs --archive backups/x.tgz.enc --compare /opt/genius/data
 *
 * - .enc 需要 `BACKUP_ENC_PASSPHRASE` 环境变量（openssl 子进程解密到临时目录）。
 * - `--compare` 只读两边文件，**绝不写 DATA_DIR**，对活着的数据目录跑是安全的。
 * - 退出码：0 摘要完成且（若 compare）两边一致；1 有差异；2 用法/输入错误。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** @param {string} message @returns {never} */
function usage(message) {
  process.stderr.write(
    `${message}\n用法: node scripts/restore-check.mjs --archive <tgz|tgz.enc> [--compare <dataDir>]\n`,
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
/** @type {string | null} */
let archivePath = null;
/** @type {string | null} */
let compareDir = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--archive") {
    archivePath = argv[++i] ?? null;
  } else if (argv[i] === "--compare") {
    compareDir = argv[++i] ?? null;
  } else {
    usage(`未知参数 ${argv[i]}`);
  }
}
if (!archivePath || archivePath.startsWith("--")) usage("--archive 需要一个文件路径");
if (argv.includes("--compare") && (!compareDir || compareDir.startsWith("--"))) {
  usage("--compare 需要一个目录路径");
}

// backup.sh 的白名单口径，必须与脚本保持一致。
const WHITELIST_DIRS = [
  "users",
  "invites",
  "gift-codes",
  "ledger",
  "agent",
  "templates",
  "canvases",
  "canvas-runs",
  "notifications",
  "prefs",
  "assets",
];

/**
 * 列出一个数据根下属于备份范围的相对路径（文件级）。
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listScopedFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir @param {string} prefix */
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  for (const d of WHITELIST_DIRS) {
    await walk(path.join(root, d), d);
  }
  try {
    if ((await stat(path.join(root, "relays.json"))).isFile()) out.push("relays.json");
  } catch {
    // 不存在就跳过。
  }
  const jobs = path.join(root, "jobs");
  try {
    for (const e of await readdir(jobs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        if ((await stat(path.join(jobs, e.name, "job.json"))).isFile()) {
          out.push(`jobs/${e.name}/job.json`);
        }
      } catch {
        // 没有 job.json 的目录不在备份范围。
      }
    }
  } catch {
    // jobs/ 不存在就跳过。
  }
  return out.sort();
}

/**
 * @param {string} root
 * @returns {Promise<{
 *   users: Map<string, { balanceCny: number, memberCreditsCny: number }>,
 *   ledgerRefs: Map<string, number>,
 *   jobJsonCount: number,
 *   canvasCount: number,
 *   canvasRunCount: number,
 *   assetCount: number,
 *   hasRelays: boolean,
 *   files: string[],
 * }>}
 */
async function summarize(root) {
  const files = await listScopedFiles(root);
  /** @type {Map<string, { balanceCny: number, memberCreditsCny: number }>} */
  const users = new Map();
  /** @type {Map<string, number>} ref → 出现次数 */
  const ledgerRefs = new Map();
  let jobJsonCount = 0;
  let canvasCount = 0;
  let canvasRunCount = 0;
  let assetCount = 0;
  let hasRelays = false;

  for (const rel of files) {
    if (rel === "relays.json") hasRelays = true;
    else if (/^jobs\/[^/]+\/job\.json$/.test(rel)) jobJsonCount += 1;
    else if (/^canvases\/.+\.json$/.test(rel)) canvasCount += 1;
    else if (rel.startsWith("canvas-runs/") && rel.endsWith(".json")) canvasRunCount += 1;
    else if (rel.startsWith("assets/")) assetCount += 1;
    else if (/^users\/[^/]+\/user\.json$/.test(rel)) {
      try {
        const doc = JSON.parse(await readFile(path.join(root, rel), "utf8"));
        const id = typeof doc.id === "string" ? doc.id : rel.split("/")[1];
        users.set(id, {
          balanceCny: typeof doc.balanceCny === "number" ? doc.balanceCny : 0,
          memberCreditsCny:
            typeof doc.memberCreditsCny === "number" ? doc.memberCreditsCny : 0,
        });
      } catch {
        users.set(rel.split("/")[1], { balanceCny: NaN, memberCreditsCny: NaN });
      }
    } else if (/^ledger\/.+\.jsonl$/.test(rel)) {
      const text = await readFile(path.join(root, rel), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          // 幂等键的口径与 src/lib/billing/protocol.mjs `keys()` 一致，且只在同一用户
          // 的流水内唯一（`signup` 这类 ref 每个账号都有一条，跨用户不算重复）。
          const owner = rel.slice("ledger/".length, -".jsonl".length);
          const keys = [];
          if (entry.kind === "charge" && entry.jobId) keys.push(`job|${entry.jobId}`);
          if (entry.kind === "grant" && entry.giftCode) keys.push(`gift|${entry.giftCode}`);
          if (typeof entry.ref === "string" && entry.ref) keys.push(`ref|${entry.kind}|${entry.ref}`);
          for (const key of keys) {
            const scoped = `${owner}|${key}`;
            ledgerRefs.set(scoped, (ledgerRefs.get(scoped) ?? 0) + 1);
          }
        } catch {
          // 非 JSON 行跳过（半截行属数据问题，比对时字节差异仍会报）。
        }
      }
    }
  }
  return { users, ledgerRefs, jobJsonCount, canvasCount, canvasRunCount, assetCount, hasRelays, files };
}

/** @param {Awaited<ReturnType<typeof summarize>>} summary @param {string} label */
function printSummary(summary, label) {
  const duplicateRefs = [...summary.ledgerRefs.values()].filter((n) => n > 1).length;
  process.stdout.write(`== ${label} ==\n`);
  process.stdout.write(`users: ${summary.users.size}\n`);
  for (const [id, u] of [...summary.users.entries()].sort()) {
    process.stdout.write(`  ${id} balanceCny=${u.balanceCny} memberCreditsCny=${u.memberCreditsCny}\n`);
  }
  process.stdout.write(`ledger refs: ${summary.ledgerRefs.size}（重复 ${duplicateRefs}）\n`);
  process.stdout.write(`jobs: ${summary.jobJsonCount}\n`);
  process.stdout.write(`canvases: ${summary.canvasCount} canvas-runs: ${summary.canvasRunCount} assets: ${summary.assetCount}\n`);
  process.stdout.write(`relays.json: ${summary.hasRelays ? "有" : "无"}\n`);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumen-restore-check-"));
let exitCode = 0;
try {
  let tgz = archivePath;
  if (archivePath.endsWith(".enc")) {
    if (!process.env.BACKUP_ENC_PASSPHRASE) {
      usage("解密 .enc 需要 BACKUP_ENC_PASSPHRASE 环境变量");
    }
    tgz = path.join(tmp, "archive.tgz");
    await run("openssl", [
      "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
      "-pass", "env:BACKUP_ENC_PASSPHRASE",
      "-in", archivePath, "-out", tgz,
    ]).catch((e) => usage(`openssl 解密失败：${e instanceof Error ? e.message : String(e)}`));
  }

  const dataRoot = path.join(tmp, "data");
  await mkdir(dataRoot, { recursive: true });
  // 包内条目是白名单相对路径（users/... jobs/<id>/job.json），直接解到临时子目录。
  // -f 只传文件名：GNU tar 会把「C:\...」里的盘符冒号当远程主机语法（host:file），
  // 在 PATH 里 GNU tar 先于 bsdtar 的 Windows 环境（如部署用 Git Bash）会失败。
  const tgzAbs = path.resolve(/** @type {string} */ (tgz));
  await run(
    "tar",
    ["-xzf", path.basename(tgzAbs), "-C", dataRoot],
    { cwd: path.dirname(tgzAbs) },
  ).catch((e) => usage(`解包失败：${e instanceof Error ? e.message : String(e)}`));

  const archive = await summarize(dataRoot);
  printSummary(archive, "archive");

  if (compareDir) {
    const live = await summarize(compareDir);
    printSummary(live, "compare");
    /** @type {string[]} */
    const diffs = [];

    const aFiles = new Set(archive.files);
    const lFiles = new Set(live.files);
    for (const f of archive.files) {
      if (!lFiles.has(f)) diffs.push(`only in archive: ${f}`);
    }
    for (const f of live.files) {
      if (!aFiles.has(f)) diffs.push(`only in ${compareDir}: ${f}`);
    }
    for (const f of archive.files) {
      if (!lFiles.has(f)) continue;
      const [a, l] = await Promise.all([
        readFile(path.join(dataRoot, f)),
        readFile(path.join(compareDir, f)),
      ]);
      if (!a.equals(l)) diffs.push(`content differs: ${f}`);
    }
    for (const [id, u] of archive.users) {
      const l = live.users.get(id);
      if (!l) continue; // only-in 已在文件级报过
      if (u.balanceCny !== l.balanceCny || u.memberCreditsCny !== l.memberCreditsCny) {
        diffs.push(`balance differs: ${id} archive(${u.balanceCny}/${u.memberCreditsCny}) live(${l.balanceCny}/${l.memberCreditsCny})`);
      }
    }
    const aRefs = [...archive.ledgerRefs.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    const lRefs = [...live.ledgerRefs.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    if (JSON.stringify(aRefs) !== JSON.stringify(lRefs)) {
      diffs.push(`ledger ref 集合不同：archive ${aRefs.length} 条 / live ${lRefs.length} 条（含计数）`);
    }

    if (diffs.length) {
      for (const d of diffs) process.stdout.write(`diff: ${d}\n`);
      process.stdout.write(`compare: ${diffs.length} 处差异\n`);
      exitCode = 1;
    } else {
      process.stdout.write("compare: 一致\n");
    }
  }
} catch (e) {
  process.stderr.write(`restore-check fail: ${e instanceof Error ? e.message : String(e)}\n`);
  exitCode = 2;
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(exitCode);
