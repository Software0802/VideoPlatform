import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { idempotencyDir } from "@/lib/jobs/store";

type Entry = { jobId: string; createdAt: string };

export async function lookupIdempotency(ownerId: string, key: string): Promise<string | null> {
  const p = fileFor(ownerId, key);
  try {
    const entry = JSON.parse(await readFile(p, "utf8")) as Entry;
    const age = Date.now() - new Date(entry.createdAt).getTime();
    if (age > 24 * 3600 * 1000) return null;
    return entry.jobId;
  } catch {
    return null;
  }
}

export async function saveIdempotency(ownerId: string, key: string, jobId: string) {
  const dir = idempotencyDir();
  await mkdir(dir, { recursive: true });
  const entry: Entry = { jobId, createdAt: new Date().toISOString() };
  await writeFile(fileFor(ownerId, key), JSON.stringify(entry));
}

/**
 * The filename is namespaced by the owner (plan §5.2). Hashing the client key
 * alone let anyone who guessed someone else's key replay — and be handed — that
 * person's job. As a side effect, records written before this change hash to a
 * different name and simply never match, which is the intended "ownerless
 * idempotency records count as a miss".
 */
function fileFor(ownerId: string, key: string) {
  const hash = createHash("sha256").update(`${ownerId}\0${key}`).digest("hex");
  return path.join(idempotencyDir(), `${hash}.json`);
}
