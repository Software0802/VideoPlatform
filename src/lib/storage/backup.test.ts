import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const bash = process.platform === "win32"
  ? path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../usr/bin/bash.exe")
  : "bash";
const exec = (args: string[], extraEnv: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  if (process.platform === "win32") {
    env.PATH = `${path.dirname(bash)};${env.PATH ?? ""}`;
  }
  return promisify(execFile)(bash, args, { timeout: 30_000, env: env as NodeJS.ProcessEnv });
};
const nodeExec = (args: string[]) =>
  promisify(execFile)(process.execPath, args, { timeout: 30_000 });
const roots: string[] = [];
const portable = (file: string) => file.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("backup facts whitelist", () => {
  it("preserves relay configuration and canvas assets without copying temporary media or caches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-backup-"));
    roots.push(root);
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    const files = {
      "users/usr_0000000000000001/user.json": "{}",
      "relays.json": '{"relays":[]}',
      "assets/usr_0000000000000001/asset_fixture": "canvas image",
      "assets/usr_0000000000000001/asset_fixture.json": "{}",
      "notifications/usr_0000000000000001.json": "{}",
      "jobs/job_fixture/job.json": "{}",
      "jobs/job_fixture/outputs/video.mp4": "generated media",
      "tmp/up_fixture": "temporary image",
      "relay-catalog/relay.json": "{}",
      "provider-health.json": "{}",
      ".env": "fixture-only",
    };
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(data, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const result = await exec([
      portable(path.resolve("scripts/backup.sh")),
      "--data-dir", portable(data),
      "--backup-dir", portable(backups),
      "--keep", "2",
    ]);
    expect(result.stdout).toContain("backup ok");
    const archives = (await readdir(backups)).filter((name) => name.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const { stdout } = await exec(["-c", 'tar --list --gzip --file "$1"', "backup-test", portable(path.join(backups, archives[0]))]);
    const entries = stdout.trim().split(/\r?\n/);
    expect(entries).toContain("relays.json");
    expect(entries).toContain("assets/usr_0000000000000001/asset_fixture");
    expect(entries).toContain("notifications/usr_0000000000000001.json");
    expect(entries).toContain("jobs/job_fixture/job.json");
    expect(entries).not.toContain("jobs/job_fixture/outputs/video.mp4");
    expect(entries).not.toContain("tmp/up_fixture");
    expect(entries).not.toContain("relay-catalog/relay.json");
    expect(entries).not.toContain("provider-health.json");
    expect(entries).not.toContain(".env");
  }, 45_000);
});

describe("backup --stop-service / offsite", () => {
  it("--stop-service 在非 root 或无 systemctl 环境下明确报错并以退出码 2 拒绝", async () => {
    // 本机（Windows Git Bash / CI runner）都不是 root，第一道路径即触发；
    // 若在 root 容器里跑则落在「无 systemctl」分支，同样退出 2。
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-backup-stop-"));
    roots.push(root);
    const data = path.join(root, "data");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "relays.json"), "{}");

    const error = await exec([
      portable(path.resolve("scripts/backup.sh")),
      "--data-dir", portable(data),
      "--backup-dir", portable(path.join(root, "backups")),
      "--stop-service",
    ]).then(
      () => null,
      (e) => e as { code?: number; stderr?: string },
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe(2);
    expect(error?.stderr).toMatch(/backup fail: --stop-service 需要/);
  }, 45_000);

  it("BACKUP_OSS_BUCKET 未配置时不产生 .enc，本地备份照常成功", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-backup-oss-"));
    roots.push(root);
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    await mkdir(path.join(data, "users", "usr_a"), { recursive: true });
    await writeFile(path.join(data, "users", "usr_a", "user.json"), "{}");
    // Git Bash 下 /opt/genius/.env 不存在，脚本只依赖进程环境变量；
    // 显式清掉，保证宿主机环境不会泄漏进断言。
    const result = await exec(
      [
        portable(path.resolve("scripts/backup.sh")),
        "--data-dir", portable(data),
        "--backup-dir", portable(backups),
      ],
      { BACKUP_OSS_BUCKET: "", OSS_ACCESS_KEY_ID: "", OSS_ACCESS_KEY_SECRET: "" },
    );
    expect(result.stdout).toContain("backup ok");
    expect(result.stdout).not.toContain("offsite");
    const files = await readdir(backups);
    expect(files.some((name) => name.endsWith(".enc"))).toBe(false);
    expect(files.filter((name) => name.endsWith(".tgz"))).toHaveLength(1);
  }, 45_000);
});

describe("restore-check", () => {
  const script = path.resolve("scripts/restore-check.mjs");

  async function makeFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-restore-check-"));
    roots.push(root);
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    const files = {
      "users/usr_a/user.json": JSON.stringify({
        id: "usr_a", balanceCny: 12.5, memberCreditsCny: 3,
      }),
      "users/usr_b/user.json": JSON.stringify({
        id: "usr_b", balanceCny: 0, memberCreditsCny: 1.2,
      }),
      "ledger/usr_a.jsonl": [
        JSON.stringify({ ref: "grant:1", kind: "grant", amountCny: 10 }),
        JSON.stringify({ ref: "charge:2", kind: "charge", amountCny: -5 }),
      ].join("\n") + "\n",
      "jobs/job_a/job.json": "{}",
      "canvases/usr_a/cnv_1.json": "{}",
      "canvas-runs/usr_a/run_1.json": "{}",
      "assets/usr_a/blob": "bytes",
      "relays.json": '{"relays":[]}',
    };
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(data, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const backup = await exec([
      portable(path.resolve("scripts/backup.sh")),
      "--data-dir", portable(data),
      "--backup-dir", portable(backups),
    ], { BACKUP_OSS_BUCKET: "" });
    expect(backup.stdout).toContain("backup ok");
    const archive = path.join(
      backups,
      (await readdir(backups)).find((name) => name.endsWith(".tgz"))!,
    );
    return { data, archive };
  }

  it("摘要数字与包内容一致；--compare 同源退出 0、改余额退出 1", async () => {
    const { data, archive } = await makeFixture();

    const summary = await nodeExec([script, "--archive", archive]);
    expect(summary.stdout).toContain("users: 2");
    expect(summary.stdout).toContain("usr_a balanceCny=12.5 memberCreditsCny=3");
    expect(summary.stdout).toContain("usr_b balanceCny=0 memberCreditsCny=1.2");
    expect(summary.stdout).toContain("ledger refs: 2（重复 0）");
    expect(summary.stdout).toContain("jobs: 1");
    expect(summary.stdout).toContain("canvases: 1 canvas-runs: 1 assets: 1");
    expect(summary.stdout).toContain("relays.json: 有");

    const same = await nodeExec([script, "--archive", archive, "--compare", data]);
    expect(same.stdout).toContain("compare: 一致");

    await writeFile(
      path.join(data, "users", "usr_a", "user.json"),
      JSON.stringify({ id: "usr_a", balanceCny: 12.4, memberCreditsCny: 3 }),
    );
    const diff = await nodeExec([script, "--archive", archive, "--compare", data]).then(
      () => null,
      (e) => e as { code?: number; stdout?: string },
    );
    expect(diff).not.toBeNull();
    expect(diff?.code).toBe(1);
    expect(diff?.stdout).toContain("balance differs: usr_a");
  }, 60_000);
});
