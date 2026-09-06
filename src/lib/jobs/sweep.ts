import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { idempotencyDir, tmpDir } from "@/lib/jobs/store";
import { log } from "@/lib/log";

const DAY = 24 * 3600 * 1000;
const MAX_TMP_BYTES = 2 * 1024 * 1024 * 1024;

type Entry = { name: string; mtime: number; size: number };

/** Stat every direct child of `dir`; a missing directory is simply empty. */
async function listEntries(dir: string): Promise<Entry[] | null> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files: Entry[] = [];
  for (const name of names) {
    try {
      const s = await stat(path.join(dir, name));
      files.push({ name, mtime: s.mtimeMs, size: s.size });
    } catch {
      /* skip */
    }
  }
  return files;
}

export async function sweepTmp() {
  const dir = tmpDir();
  const files = await listEntries(dir);
  if (!files) return;
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

/**
 * `data/idempotency/` (plan §8). Each file is a tiny `{ jobId, createdAt }` replay
 * mapping, and `lookupIdempotency` already treats anything older than 24 h as a
 * miss — past that point the file only makes the directory grow. Same 24 h rule as
 * `data/tmp/`, no size cap: these files are a few dozen bytes each.
 */
export async function sweepIdempotency() {
  const dir = idempotencyDir();
  const files = await listEntries(dir);
  if (!files) return;
  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    if (now - f.mtime <= DAY) continue;
    await rm(path.join(dir, f.name), { force: true }).catch(() => undefined);
    removed += 1;
  }
  log("info", "sweepIdempotency", { removed, remaining: files.length - removed });
}
