import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "@/lib/agent/schema";
import type { CanvasDocument, CanvasRun } from "@/lib/canvas/schema";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 14, 0, 0, 0);
const OLD = new Date(NOW - 90 * DAY_MS).toISOString();
const NEW = new Date(NOW - DAY_MS).toISOString();

let dataRoot = "";
let sweep: typeof import("./sweep");
let agentStore: typeof import("@/lib/agent/store");
let canvasStore: typeof import("@/lib/canvas/store");
let runStore: typeof import("@/lib/canvas/run-store");

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-archive-test-"));
  process.env.DATA_DIR = dataRoot;
  sweep = await import("./sweep");
  agentStore = await import("@/lib/agent/store");
  canvasStore = await import("@/lib/canvas/store");
  runStore = await import("@/lib/canvas/run-store");
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function sessionFixture(
  ownerId: string,
  id: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    schemaVersion: 1,
    id,
    ownerId,
    title: id,
    messages: [],
    jobIds: [],
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

function canvasFixture(
  ownerId: string,
  id: string,
  updatedAt: string,
  overrides: Partial<CanvasDocument> = {},
): CanvasDocument {
  return {
    schemaVersion: 1,
    id,
    ownerId,
    title: id,
    revision: 3,
    nodes: [],
    edges: [],
    createdAt: OLD,
    updatedAt,
    ...overrides,
  };
}

function runFixture(
  ownerId: string,
  id: string,
  canvasId: string,
  overrides: Partial<CanvasRun> = {},
): CanvasRun {
  return {
    schemaVersion: 1,
    id,
    ownerId,
    canvasId,
    documentRevision: 3,
    graphSnapshot: { nodes: [], edges: [] },
    quote: { hash: "archive-quote", totalCny: 0, items: [] },
    status: "succeeded",
    nodeExecutions: [],
    createdAt: OLD,
    updatedAt: OLD,
    finishedAt: OLD,
    ...overrides,
  };
}

const activeTurn = {
  id: "msg_00000000000000aa",
  requestHash: "0".repeat(64),
  status: "awaiting_approval" as const,
  priceCny: 0.05,
  chargeRef: "agent:archive-active",
  jobIds: [],
  createdAt: OLD,
  updatedAt: OLD,
};

describe("archive decisions", () => {
  it("uses an inclusive N-day boundary and disables at days=0", () => {
    const session = sessionFixture("usr_00000000000000a1", "ses_0000000000000001");
    expect(sweep.shouldArchiveSession(session, NOW, 90)).toBe(true);
    expect(
      sweep.shouldArchiveSession({ ...session, updatedAt: new Date(NOW - 90 * DAY_MS + 1).toISOString() }, NOW, 90),
    ).toBe(false);
    expect(sweep.shouldArchiveSession(session, NOW, 0)).toBe(false);
    expect(sweep.shouldArchiveSession({ ...session, archivedAt: OLD }, NOW, 90)).toBe(false);
    expect(sweep.shouldArchiveSession({ ...session, turns: [activeTurn] }, NOW, 90)).toBe(false);
  });

  it("protects the newest canvas and canvases with running runs", () => {
    const doc = canvasFixture("usr_00000000000000a1", "cv_000000000001", OLD);
    expect(sweep.shouldArchiveCanvas(doc, "cv_000000000002", false, NOW, 90)).toBe(true);
    expect(sweep.shouldArchiveCanvas(doc, doc.id, false, NOW, 90)).toBe(false);
    expect(
      sweep.shouldArchiveCanvas(
        { ...doc, updatedAt: new Date(NOW - 90 * DAY_MS + 1).toISOString() },
        "cv_000000000002",
        false,
        NOW,
        90,
      ),
    ).toBe(false);
    expect(sweep.shouldArchiveCanvas(doc, "cv_000000000002", true, NOW, 90)).toBe(false);
    expect(sweep.shouldArchiveCanvas({ ...doc, archivedAt: OLD }, "cv_000000000002", false, NOW, 90)).toBe(false);
    expect(sweep.shouldArchiveCanvas(doc, "cv_000000000002", false, NOW, 0)).toBe(false);
  });

  it("archives only old terminal runs", () => {
    const run = runFixture("usr_00000000000000a1", "crun_000000000001", "cv_000000000001");
    expect(sweep.shouldArchiveRun(run, NOW, 90)).toBe(true);
    expect(
      sweep.shouldArchiveRun({ ...run, finishedAt: new Date(NOW - 90 * DAY_MS + 1).toISOString() }, NOW, 90),
    ).toBe(false);
    expect(sweep.shouldArchiveRun({ ...run, status: "running" }, NOW, 90)).toBe(false);
    expect(sweep.shouldArchiveRun(run, NOW, 0)).toBe(false);
  });
});

describe("sweepArchive", () => {
  it("archives two users idempotently without changing held funds", async () => {
    const a = "usr_00000000000000b1";
    const b = "usr_00000000000000b2";
    const oldSessionA = sessionFixture(a, "ses_0000000000000011");
    const activeSessionA = sessionFixture(a, "ses_0000000000000012", { turns: [activeTurn] });
    const oldSessionB = sessionFixture(b, "ses_0000000000000021");
    await agentStore.writeSession(oldSessionA);
    await agentStore.writeSession(activeSessionA);
    await agentStore.writeSession(oldSessionB);

    const oldCanvasA = canvasFixture(a, "cv_000000000011", OLD);
    const protectedCanvasA = canvasFixture(a, "cv_000000000012", OLD);
    const newestCanvasA = canvasFixture(a, "cv_000000000013", NEW);
    const oldCanvasB = canvasFixture(b, "cv_000000000021", OLD);
    const newestCanvasB = canvasFixture(b, "cv_000000000022", NEW);
    for (const doc of [oldCanvasA, protectedCanvasA, newestCanvasA, oldCanvasB, newestCanvasB]) {
      await canvasStore.writeCanvas(doc);
    }

    const terminalA = runFixture(a, "crun_000000000011", oldCanvasA.id, {
      reservation: {
        amountCny: 4,
        memberCny: 1,
        purchasedCny: 3,
        remainingCny: 4,
        remainingMemberCny: 1,
        remainingPurchasedCny: 3,
        transfers: {},
        createdAt: OLD,
      },
    });
    const runningA = runFixture(a, "crun_000000000012", protectedCanvasA.id, {
      status: "running",
      finishedAt: undefined,
      reservation: {
        amountCny: 2,
        memberCny: 0,
        purchasedCny: 2,
        remainingCny: 2,
        remainingMemberCny: 0,
        remainingPurchasedCny: 2,
        transfers: {},
        createdAt: OLD,
      },
    });
    const terminalB = runFixture(b, "crun_000000000021", oldCanvasB.id);
    await runStore.writeCanvasRun(terminalA);
    await runStore.writeCanvasRun(runningA);
    await runStore.writeCanvasRun(terminalB);

    const heldBefore = await runStore.runHeldFunds(a, []);
    expect(heldBefore.remainingCny).toBe(2);

    await expect(sweep.sweepArchive({ nowMs: NOW, days: 90 })).resolves.toEqual({
      sessions: 2,
      canvases: 2,
      runs: 2,
      failed: 0,
    });

    expect((await agentStore.readSession(a, oldSessionA.id))?.archivedAt).toBe(
      new Date(NOW).toISOString(),
    );
    expect((await agentStore.readSession(a, activeSessionA.id))?.archivedAt).toBeUndefined();
    expect((await canvasStore.readCanvas(a, oldCanvasA.id))?.archivedAt).toBe(
      new Date(NOW).toISOString(),
    );
    expect((await canvasStore.readCanvas(a, protectedCanvasA.id))?.archivedAt).toBeUndefined();
    expect((await canvasStore.listCanvases(a)).map((doc) => doc.id)).not.toContain(oldCanvasA.id);

    await expect(access(runStore.canvasRunPath(a, terminalA.id))).rejects.toThrow();
    await expect(access(runStore.archivedCanvasRunPath(a, terminalA.id))).resolves.toBeUndefined();
    expect((await runStore.listCanvasRuns(a)).map((run) => run.id)).toEqual([runningA.id]);
    expect((await runStore.readCanvasRun(a, terminalA.id))?.id).toBe(terminalA.id);
    expect(await runStore.runHeldFunds(a, [])).toEqual(heldBefore);

    await runStore.updateCanvasRun(a, terminalA.id, (run) => ({
      ...run,
      documentRevision: run.documentRevision + 1,
    }));
    await expect(access(runStore.canvasRunPath(a, terminalA.id))).rejects.toThrow();
    expect((await runStore.readCanvasRun(a, terminalA.id))?.documentRevision).toBe(4);
    await expect(access(runStore.archivedCanvasRunPath(a, terminalA.id))).resolves.toBeUndefined();

    await expect(sweep.sweepArchive({ nowMs: NOW, days: 90 })).resolves.toEqual({
      sessions: 0,
      canvases: 0,
      runs: 0,
      failed: 0,
    });
    await expect(runStore.deleteCanvasRun(a, terminalA.id)).resolves.toBe(true);
    await expect(runStore.readCanvasRun(a, terminalA.id)).resolves.toBeNull();
  });
});
