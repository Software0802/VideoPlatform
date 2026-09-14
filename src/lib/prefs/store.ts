import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import { USER_ID_RE } from "@/lib/users/schema";
import { assertUserId } from "@/lib/users/store";

const userPrefsSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(USER_ID_RE),
  agent: z.object({ skillsOff: z.array(z.string().min(1)) }),
  updatedAt: z.string(),
});
export type UserPrefs = z.infer<typeof userPrefsSchema>;

export function prefsDir(): string {
  return path.join(dataDir(), "prefs");
}

export function prefsPath(ownerId: string): string {
  assertUserId(ownerId);
  return path.join(prefsDir(), `${ownerId}.json`);
}

type GlobalLockState = typeof globalThis & {
  __lumenPrefsLocks?: Map<string, Promise<void>>;
};
const globalLockState = globalThis as GlobalLockState;
const locks = globalLockState.__lumenPrefsLocks ?? (globalLockState.__lumenPrefsLocks = new Map());

async function withPrefsLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(ownerId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(ownerId, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(ownerId) === current) locks.delete(ownerId);
  }
}

function emptyPrefs(ownerId: string): UserPrefs {
  return {
    schemaVersion: 1,
    ownerId,
    agent: { skillsOff: [] },
    updatedAt: new Date().toISOString(),
  };
}

async function loadPrefs(ownerId: string): Promise<UserPrefs> {
  let raw: string;
  try {
    raw = await readFile(prefsPath(ownerId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPrefs(ownerId);
    throw error;
  }
  const parsed = userPrefsSchema.safeParse(safeJson(raw));
  if (parsed.success && parsed.data.ownerId === ownerId) return parsed.data;
  log("warn", "偏好文件损坏，以空偏好重建", { ownerId });
  const rebuilt = emptyPrefs(ownerId);
  await writeJsonAtomic(prefsPath(ownerId), rebuilt);
  return rebuilt;
}

export async function readPrefs(ownerId: string): Promise<UserPrefs> {
  assertUserId(ownerId);
  return withPrefsLock(ownerId, () => loadPrefs(ownerId));
}

export async function setAgentSkillOff(
  ownerId: string,
  skillId: string,
  off: boolean,
): Promise<UserPrefs> {
  assertUserId(ownerId);
  return withPrefsLock(ownerId, async () => {
    const current = await loadPrefs(ownerId);
    const skills = new Set(current.agent.skillsOff);
    if (off) skills.add(skillId);
    else skills.delete(skillId);
    const skillsOff = [...skills].sort();
    if (JSON.stringify(skillsOff) === JSON.stringify(current.agent.skillsOff)) return current;
    const next: UserPrefs = {
      ...current,
      agent: { skillsOff },
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(prefsPath(ownerId), next);
    return next;
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
