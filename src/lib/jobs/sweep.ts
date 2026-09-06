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
 * 「现在就查一遍暂存区」的即发即忘版本（方案 §3.2「安全收口」）。
 *
 * `POST /api/uploads` 之后调它：容量上限挂在 runner 每小时一次的定时器上，而把
 * `data/tmp/` 撑到 2GB 只需要几十次上传——等一小时的意思就是「这一小时里磁盘随便涨」。
 *
 * 两条纪律：
 * - **不 await**：调用方是一次用户请求，扫目录的时间不该记在它的响应时间里。
 * - **同一时刻只跑一个**：连着传十张图会打十次，十次并发扫同一个目录只会互相删到
 *   对方正在 stat 的文件。已经在跑时直接返回——正在跑的那一次本来就会看到新文件。
 */
type SweepState = { running: boolean };
const globalSweepState = globalThis as typeof globalThis & { __lumenTmpSweep?: SweepState };

export function sweepTmpSoon(): void {
  const state = (globalSweepState.__lumenTmpSweep ??= { running: false });
  if (state.running) return;
  state.running = true;
  void sweepTmp()
    .catch((error) => {
      log("warn", "sweepTmp 即时检查失败", {
        msg: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      state.running = false;
    });
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
