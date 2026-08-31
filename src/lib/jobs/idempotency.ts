import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { idempotencyDir } from "@/lib/jobs/store";

type Entry = { jobId: string; createdAt: string };

export async function lookupIdempotency(key: string): Promise<string | null> {
  const p = fileFor(key);
  try {
    const entry = JSON.parse(await readFile(p, "utf8")) as Entry;
    const age = Date.now() - new Date(entry.createdAt).getTime();
    if (age > 24 * 3600 * 1000) return null;
    return entry.jobId;
  } catch {
    return null;
  }
}

export async function saveIdempotency(key: string, jobId: string) {
  const dir = idempotencyDir();
  await mkdir(dir, { recursive: true });
  const entry: Entry = { jobId, createdAt: new Date().toISOString() };
  await writeFile(fileFor(key), JSON.stringify(entry));
}

function fileFor(key: string) {
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(idempotencyDir(), `${hash}.json`);
}
