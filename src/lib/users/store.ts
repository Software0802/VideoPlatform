import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import {
  USER_ID_RE,
  normalizeEmail,
  userIndexSchema,
  userRecordSchema,
  type UserRecord,
} from "@/lib/users/schema";

export function usersDir(): string {
  return path.join(dataDir(), "users");
}

export function userIndexPath(): string {
  return path.join(usersDir(), "index.json");
}

export function assertUserId(id: string): void {
  if (!USER_ID_RE.test(id)) throw new Error("invalid user id");
}

export function userDir(id: string): string {
  assertUserId(id);
  return path.join(usersDir(), id);
}

export function userFilePath(id: string): string {
  return path.join(userDir(id), "user.json");
}

export function newUserId(): string {
  return `usr_${randomBytes(8).toString("hex")}`;
}

export async function readUser(id: string): Promise<UserRecord | null> {
  if (!USER_ID_RE.test(id)) return null;
  try {
    const raw = await readFile(userFilePath(id), "utf8");
    const parsed = userRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.id !== id) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Atomic replace of the source of truth. Callers hold `withUserLock`. */
export async function writeUser(user: UserRecord): Promise<UserRecord> {
  const record = userRecordSchema.parse({ ...user, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(userFilePath(record.id), record);
  return record;
}

async function listUserIds(): Promise<string[]> {
  try {
    const names = await readdir(usersDir());
    return names.filter((name) => USER_ID_RE.test(name));
  } catch {
    return [];
  }
}

/**
 * The index is a derived cache. Cached per data root so a test (or a runtime
 * `DATA_DIR` change) can never read another workspace's map.
 */
type IndexCache = { root: string; map: Map<string, string> };
type GlobalIndexState = typeof globalThis & { __lumenUserIndex?: IndexCache };
const globalIndexState = globalThis as GlobalIndexState;

function cached(): Map<string, string> | null {
  const entry = globalIndexState.__lumenUserIndex;
  return entry && entry.root === usersDir() ? entry.map : null;
}

function setCache(map: Map<string, string>): Map<string, string> {
  globalIndexState.__lumenUserIndex = { root: usersDir(), map };
  return map;
}

/** Drop the in-process cache; the next read reloads from disk. Tests only. */
export function resetUserIndexCache(): void {
  delete globalIndexState.__lumenUserIndex;
}

async function readIndexFile(): Promise<Map<string, string> | null> {
  try {
    const raw = await readFile(userIndexPath(), "utf8");
    const parsed = userIndexSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return new Map(Object.entries(parsed.data));
  } catch {
    return null;
  }
}

async function writeIndexFile(map: Map<string, string>): Promise<void> {
  const object: Record<string, string> = {};
  for (const email of [...map.keys()].sort()) object[email] = map.get(email)!;
  await writeJsonAtomic(userIndexPath(), object);
}

/** Scan `data/users/ * /user.json` — the only authority — and rewrite index.json. */
export async function rebuildUserIndex(): Promise<Map<string, string>> {
  const map = await buildFromDisk();
  await writeIndexFile(map);
  return setCache(map);
}

function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Load the email → id map, healing it when index.json is missing, corrupt or
 * out of step with the user directories (§2: crash between the two writes).
 */
export async function loadUserIndex(): Promise<Map<string, string>> {
  const hit = cached();
  if (hit) return hit;
  const fromFile = await readIndexFile();
  const rebuilt = await buildFromDisk();
  if (!fromFile || !sameEntries(fromFile, rebuilt)) {
    if (fromFile) {
      log("warn", "user index out of date, rebuilt from user.json files", {
        indexed: fromFile.size,
        scanned: rebuilt.size,
      });
    }
    await writeIndexFile(rebuilt);
  }
  return setCache(rebuilt);
}

async function buildFromDisk(): Promise<Map<string, string>> {
  const ids = (await listUserIds()).sort();
  const map = new Map<string, string>();
  const claimedAt = new Map<string, string>();
  for (const id of ids) {
    const user = await readUser(id);
    if (!user) continue;
    const email = normalizeEmail(user.email);
    const previous = claimedAt.get(email);
    // Deterministic tie-break if two records ever claim one address: oldest wins.
    if (previous === undefined || user.createdAt < previous) {
      map.set(email, user.id);
      claimedAt.set(email, user.createdAt);
    }
  }
  return map;
}

/** Startup hook: validate the derived index against the directories. */
export async function ensureUserIndex(): Promise<void> {
  resetUserIndexCache();
  await loadUserIndex();
}

/** Second step of the fixed write order: user.json first, then the index. */
export async function setIndexEntry(email: string, id: string): Promise<void> {
  const map = await loadUserIndex();
  map.set(normalizeEmail(email), id);
  await writeIndexFile(map);
  setCache(map);
}

export async function findUserIdByEmail(email: string): Promise<string | undefined> {
  const map = await loadUserIndex();
  return map.get(normalizeEmail(email));
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const id = await findUserIdByEmail(email);
  if (!id) return null;
  return readUser(id);
}
