import { readdir } from "node:fs/promises";
import { agentDir, agentUserDir, readSession, updateSession } from "@/lib/agent/store";
import { AGENT_SESSION_ID_RE, type AgentSession } from "@/lib/agent/schema";
import { CANVAS_ID_RE, type CanvasDocument, type CanvasRun } from "@/lib/canvas/schema";
import {
  archiveCanvasRun,
  canvasRunsDir,
  listCanvasRuns,
} from "@/lib/canvas/run-store";
import { archiveCanvas, canvasDir, canvasUserDir, readCanvas } from "@/lib/canvas/store";
import { archiveInactiveDays } from "@/lib/env";
import { log } from "@/lib/log";
import { USER_ID_RE } from "@/lib/users/schema";

const DAY_MS = 86_400_000;
const ACTIVE_TURNS = new Set(["thinking", "executing", "awaiting_approval"]);

function isOld(iso: string, nowMs: number, days: number): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && nowMs - at >= days * DAY_MS;
}

export function shouldArchiveSession(session: AgentSession, nowMs: number, days: number): boolean {
  if (days <= 0 || session.archivedAt || !isOld(session.updatedAt, nowMs, days)) return false;
  return !(session.turns ?? []).some((turn) => ACTIVE_TURNS.has(turn.status));
}

export function shouldArchiveCanvas(
  doc: CanvasDocument,
  newestId: string | undefined,
  hasRunningRun: boolean,
  nowMs: number,
  days: number,
): boolean {
  if (days <= 0 || doc.archivedAt || doc.id === newestId || hasRunningRun) return false;
  return isOld(doc.updatedAt, nowMs, days);
}

export function shouldArchiveRun(run: CanvasRun, nowMs: number, days: number): boolean {
  if (days <= 0 || run.status === "running") return false;
  return isOld(run.finishedAt ?? run.updatedAt, nowMs, days);
}

export type ArchiveSweepResult = {
  sessions: number;
  canvases: number;
  runs: number;
  failed: number;
};

async function ownerIds(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && USER_ID_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function newestCanvasId(docs: CanvasDocument[]): string | undefined {
  return docs.reduce<CanvasDocument | undefined>((newest, doc) => {
    if (!newest) return doc;
    const delta = Date.parse(doc.updatedAt) - Date.parse(newest.updatedAt);
    if (delta > 0 || (delta === 0 && doc.id > newest.id)) return doc;
    return newest;
  }, undefined)?.id;
}

export async function sweepArchive(
  opts: { nowMs?: number; days?: number } = {},
): Promise<ArchiveSweepResult> {
  const days = opts.days ?? archiveInactiveDays();
  const result: ArchiveSweepResult = { sessions: 0, canvases: 0, runs: 0, failed: 0 };
  if (days <= 0) return result;

  const nowMs = opts.nowMs ?? Date.now();
  const stamp = new Date(nowMs).toISOString();
  const owners = new Set<string>([
    ...(await ownerIds(agentDir())),
    ...(await ownerIds(canvasDir())),
    ...(await ownerIds(canvasRunsDir())),
  ]);

  for (const ownerId of owners) {
    let sessionNames: string[] = [];
    try {
      sessionNames = await namesIn(agentUserDir(ownerId));
    } catch (error) {
      result.failed += 1;
      logFailure("sessions", ownerId, error);
    }
    for (const name of sessionNames) {
      const sessionId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!AGENT_SESSION_ID_RE.test(sessionId)) continue;
      try {
        const session = await readSession(ownerId, sessionId);
        if (!session || !shouldArchiveSession(session, nowMs, days)) continue;
        let archived = false;
        await updateSession(ownerId, sessionId, (current) => {
          if (!shouldArchiveSession(current, nowMs, days)) return undefined;
          archived = true;
          return { ...current, archivedAt: stamp };
        });
        if (archived) result.sessions += 1;
      } catch (error) {
        result.failed += 1;
        logFailure("session", `${ownerId}/${sessionId}`, error);
      }
    }

    let canvasNames: string[] = [];
    try {
      canvasNames = await namesIn(canvasUserDir(ownerId));
    } catch (error) {
      result.failed += 1;
      logFailure("canvases", ownerId, error);
    }
    const docs = (
      await Promise.all(
        canvasNames
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -5))
          .filter((id) => CANVAS_ID_RE.test(id))
          .map((id) => readCanvas(ownerId, id)),
      )
    ).filter((doc): doc is CanvasDocument => doc !== null);
    const runs = await listCanvasRuns(ownerId);
    const runningCanvasIds = new Set(
      runs.filter((run) => run.status === "running").map((run) => run.canvasId),
    );
    const newestId = newestCanvasId(docs);
    for (const doc of docs) {
      const hasRunningRun = runningCanvasIds.has(doc.id);
      if (!shouldArchiveCanvas(doc, newestId, hasRunningRun, nowMs, days)) continue;
      try {
        let archived = false;
        await archiveCanvas(ownerId, doc.id, stamp, (current) => {
          archived = shouldArchiveCanvas(current, newestId, hasRunningRun, nowMs, days);
          return archived;
        });
        if (archived) result.canvases += 1;
      } catch (error) {
        result.failed += 1;
        logFailure("canvas", `${ownerId}/${doc.id}`, error);
      }
    }

    for (const run of runs) {
      if (!shouldArchiveRun(run, nowMs, days)) continue;
      try {
        if (await archiveCanvasRun(ownerId, run.id)) result.runs += 1;
      } catch (error) {
        result.failed += 1;
        logFailure("run", `${ownerId}/${run.id}`, error);
      }
    }
  }

  if (result.sessions || result.canvases || result.runs || result.failed) {
    log("info", "sweepArchive", { ...result, days });
  }
  return result;
}

function logFailure(kind: string, id: string, error: unknown): void {
  log("warn", "archive sweep item failed", {
    kind,
    id,
    msg: error instanceof Error ? error.message : String(error),
  });
}
