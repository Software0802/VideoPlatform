import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "@/lib/jobs/store";
import { log } from "@/lib/log";

const DAY = 24 * 3600 * 1000;
const MAX_TMP_BYTES = 2 * 1024 * 1024 * 1024;

export async function sweepTmp() {
  const dir = tmpDir();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const files: { name: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    try {
      const s = await stat(abs);
      files.push({ name, mtime: s.mtimeMs, size: s.size });
    } catch {
      /* skip */
    }
  }
  const now = Date.now();
  for (const f of files) {
    if (now - f.mtime > DAY) {
      await rm(path.join(dir, f.name), { force: true });
    }
  }
  const left = files.filter((f) => now - f.mtime <= DAY).sort((a, b) => a.mtime - b.mtime);
  let total = left.reduce((n, f) => n + f.size, 0);
  for (const f of left) {
    if (total <= MAX_TMP_BYTES) break;
    await rm(path.join(dir, f.name), { force: true });
    total -= f.size;
  }
  log("info", "sweepTmp", { remaining: left.length });
}
