import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import {
  clampProgress,
  jobPublicSchema,
  type JobPublic,
  type JobRecord,
} from "@/lib/jobs/schema";
import { retryBlock } from "@/lib/jobs/retry-guard";
import { mediaStore } from "@/lib/storage/local-fs";

type GlobalLockState = typeof globalThis & {
  __lumenJobLocks?: Map<string, Promise<void>>;
};

const globalLockState = globalThis as GlobalLockState;
const locks = globalLockState.__lumenJobLocks ?? (globalLockState.__lumenJobLocks = new Map());

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(id, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === current) locks.delete(id);
  }
}

export function toPublic(rec: JobRecord): JobPublic {
  const pub = {
    id: rec.id,
    status: rec.status,
    progress: clampProgress(rec.progress),
    mode: rec.mode,
    model: rec.model,
    provider: rec.provider,
    prompt: rec.prompt,
    durationSec: rec.durationSec,
    aspectRatio: rec.aspectRatio,
    resolution: rec.resolution,
    generateAudio: rec.generateAudio,
    lastFrameStored: rec.lastFrameStored,
    lastFrameLocksOutput: false as const,
    harness: { enabled: Boolean(rec.harness?.enabled) },
    costUsdEstimate: rec.costUsdEstimate,
    costUsdPlanned: rec.costUsdPlanned ?? null,
    costUsdActual: rec.costUsdActual,
    costIncomplete: Boolean(rec.costIncomplete),
    costOverTarget: Boolean(rec.costOverTarget),
    imageResolution: rec.imageResolution ?? null,
    error: rec.error,
    output: coerceOutput(rec.output),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    bible: null,
    retryBlocked: retryBlock(rec),
    shots: publicShots(rec),
  };
  return jobPublicSchema.parse(pub);
}

function publicShots(rec: JobRecord): JobPublic["shots"] {
  if (!rec.harnessPlan || !rec.harnessShots) return null;
  const durations = new Map(rec.harnessPlan.shots.map((s) => [s.id, s.durationSec]));
  return rec.harnessShots
    .map((s) => ({
      id: s.id,
      index: s.index,
      durationSec: durations.get(s.id) ?? 0,
      status: s.status,
      retries: s.retries,
      error: s.error ?? null,
    }))
    .sort((a, b) => a.index - b.index);
}

function coerceOutput(raw: JobRecord["output"] | { videoUrl?: string; posterUrl?: string; durationSec?: number; imageUrl?: string; kind?: string } | null): JobPublic["output"] {
  if (!raw) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "image" && typeof o.imageUrl === "string") {
    return { kind: "image", imageUrl: o.imageUrl };
  }
  if (typeof o.imageUrl === "string" && !o.videoUrl) {
    return { kind: "image", imageUrl: o.imageUrl };
  }
  if (typeof o.videoUrl === "string") {
    return {
      kind: "video",
      videoUrl: o.videoUrl,
      posterUrl: typeof o.posterUrl === "string" ? o.posterUrl : "",
      durationSec: typeof o.durationSec === "number" ? o.durationSec : 0,
    };
  }
  return null;
}

export async function writeJob(rec: JobRecord): Promise<JobRecord> {
  return withLock(rec.id, async () => {
    rec.updatedAt = new Date().toISOString();
    const dir = mediaStore.jobDir(rec.id);
    await mkdir(dir, { recursive: true });
    await writeJobJson(dir, rec);
    return rec;
  });
}

export async function readJob(id: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(path.join(mediaStore.jobDir(id), "job.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export async function updateJob(
  id: string,
  fn: (rec: JobRecord) => JobRecord | Promise<JobRecord>,
): Promise<JobRecord> {
  return withLock(id, async () => {
    const rec = await readJobUnlocked(id);
    if (!rec) throw new Error("job not found");
    const next = await fn(rec);
    next.updatedAt = new Date().toISOString();
    const dir = mediaStore.jobDir(id);
    await mkdir(dir, { recursive: true });
    await writeJobJson(dir, next);
    return next;
  });
}

async function writeJobJson(dir: string, record: JobRecord): Promise<void> {
  // Temporary file + atomic rename, with the Windows retry — see
  // `@/lib/storage/atomic-json`, which the user store shares.
  await writeJsonAtomic(path.join(dir, "job.json"), record);
}

async function readJobUnlocked(id: string): Promise<JobRecord | null> {
  try {
    const raw = await readFile(path.join(mediaStore.jobDir(id), "job.json"), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export async function listJobRecords(): Promise<JobRecord[]> {
  const ids = await mediaStore.listJobs();
  const out: JobRecord[] = [];
  for (const id of ids) {
    const rec = await readJob(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export function tmpDir() {
  return path.join(dataDir(), "tmp");
}

export function idempotencyDir() {
  return path.join(dataDir(), "idempotency");
}
