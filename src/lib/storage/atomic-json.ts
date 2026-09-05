import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Replace a JSON file atomically: write a uniquely named temporary file next to
 * the destination, then rename it over the target. The temporary name keeps
 * independent requests/processes from clobbering one another, and the rename is
 * the only step readers can observe.
 *
 * Extracted from `src/lib/jobs/store.ts` so job records, user records and the
 * user index all share one implementation — including the Windows retry below.
 */
export async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
  const dir = path.dirname(destination);
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(destination)}-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await renameWithRetry(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Windows can briefly reject replacing a file that a read stream still has
 * open, so retry the atomic rename for a short, bounded window before
 * surfacing the error.
 */
export async function renameWithRetry(source: string, destination: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EBUSY" || code === "EACCES") || attempt >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 160)));
    }
  }
}
