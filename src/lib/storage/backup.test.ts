import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const bash = process.platform === "win32"
  ? path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../usr/bin/bash.exe")
  : "bash";
const exec = (args: string[]) => promisify(execFile)(bash, args, {
  timeout: 30_000,
  env: process.platform === "win32"
    ? { ...process.env, PATH: `${path.dirname(bash)};${process.env.PATH ?? ""}` }
    : process.env,
});
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
