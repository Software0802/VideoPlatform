import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeQuotaUsage } from "./quota";
import { shouldPurgeArtifacts, type RetentionJob } from "./retention";
import type { JobRecord, JobStatus } from "./schema";

/**
 * Artifact retention (plan §8). The rule itself is pure and takes `now`, so the
 * 30-day boundary is checked without waiting a month; the sweep is exercised
 * against a real temporary DATA_DIR because deleting files and stamping
 * `job.json` is the whole point.
 */

const OWNER = "usr_00000000000000a1";
const DAY = 86_400_000;
/** 2026-09-06 12:00 Beijing, an arbitrary but fixed "now". */
const NOW = Date.parse("2026-09-06T04:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let dataRoot = "";
let sweepRetention: typeof import("./retention").sweepRetention;
let readJob: typeof import("./store").readJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-retention-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ sweepRetention } = await import("./retention"));
  ({ readJob } = await import("./store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.DATA_RETENTION_DAYS;
  await rm(path.join(dataRoot, "jobs"), { recursive: true, force: true });
});

function retentionJob(over: Partial<RetentionJob> = {}): RetentionJob {
  return {
    id: "job_aaaaaaaaaaaa",
    status: "succeeded",
    updatedAt: ago(40 * DAY),
    ...over,
  };
}

/** A finished job on disk, with the artifacts a real one would have left behind. */
async function seedJob(
  id: string,
  over: Partial<JobRecord> = {},
  opts: { dirName?: string } = {},
): Promise<{ dir: string; outputs: string; inputs: string }> {
  const dir = path.join(dataRoot, "jobs", opts.dirName ?? id);
  const outputs = path.join(dir, "outputs", "video.mp4");
  const inputs = path.join(dir, "inputs", "start.jpg");
  await mkdir(path.dirname(outputs), { recursive: true });
  await mkdir(path.dirname(inputs), { recursive: true });
  await writeFile(outputs, "film");
  await writeFile(inputs, "frame");
  const settled = over.updatedAt ?? ago(40 * DAY);
  const rec = {
    schemaVersion: 1,
    id,
    ownerId: OWNER,
    status: "succeeded" as JobStatus,
    progress: 100,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt: "旧仓库里的一束光",
    durationSec: 0,
    aspectRatio: "16:9",
    resolution: null,
    imageResolution: "1k",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    costUsdEstimate: 0.02,
    costUsdActual: 0.02,
    error: null,
    output: { kind: "image", imageUrl: `/api/media/${id}/image.jpg` },
    createdAt: settled,
    updatedAt: settled,
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
  await writeFile(path.join(dir, "job.json"), JSON.stringify(rec));
  return { dir, outputs, inputs };
}

const exists = (file: string) => access(file).then(() => true, () => false);

describe("shouldPurgeArtifacts", () => {
  it("keeps a job one hour short of the retention window and purges one past it", () => {
    expect(shouldPurgeArtifacts(retentionJob({ updatedAt: ago(30 * DAY - 3600_000) }), NOW, 30)).toBe(false);
    expect(shouldPurgeArtifacts(retentionJob({ updatedAt: ago(30 * DAY + 1000) }), NOW, 30)).toBe(true);
  });

  it("never touches a job that has not reached a terminal status", () => {
    const running: JobStatus[] = ["queued", "submitting", "pending", "persisting", "generating_shots"];
    for (const status of running) {
      expect(shouldPurgeArtifacts(retentionJob({ status }), NOW, 30)).toBe(false);
    }
    const terminal: JobStatus[] = ["succeeded", "failed", "canceled", "expired"];
    for (const status of terminal) {
      expect(shouldPurgeArtifacts(retentionJob({ status }), NOW, 30)).toBe(true);
    }
  });

  it("skips a job that was already purged", () => {
    expect(shouldPurgeArtifacts(retentionJob({ artifactsPurgedAt: ago(DAY) }), NOW, 30)).toBe(false);
  });

  it("ages the job by completedAt, not by a later updatedAt", () => {
    // Purged long ago, rewritten yesterday (a cost correction): still expired.
    expect(
      shouldPurgeArtifacts(retentionJob({ completedAt: ago(40 * DAY), updatedAt: ago(DAY) }), NOW, 30),
    ).toBe(true);
    // Finished an hour ago on a record whose updatedAt looks ancient: keep it.
    expect(
      shouldPurgeArtifacts(retentionJob({ completedAt: ago(3600_000), updatedAt: ago(40 * DAY) }), NOW, 30),
    ).toBe(false);
  });

  it("is disabled at zero days", () => {
    expect(shouldPurgeArtifacts(retentionJob({ updatedAt: ago(400 * DAY) }), NOW, 0)).toBe(false);
  });
});

describe("sweepRetention", () => {
  it("deletes outputs/ and inputs/, stamps artifactsPurgedAt, and leaves status alone", async () => {
    const { outputs, inputs } = await seedJob("job_expired0001");

    const result = await sweepRetention({ nowMs: NOW, retentionDays: 30 });

    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(await exists(outputs)).toBe(false);
    expect(await exists(inputs)).toBe(false);
    const rec = await readJob("job_expired0001");
    expect(rec?.status).toBe("succeeded");
    expect(rec?.artifactsPurgedAt).toBe(new Date(NOW).toISOString());
    // The record itself survives — it is the history the works ring still shows.
    expect(rec?.prompt).toBe("旧仓库里的一束光");
  });

  it("leaves a recent job and a still-running one untouched", async () => {
    const fresh = await seedJob("job_fresh00000001", { updatedAt: ago(DAY), createdAt: ago(DAY) });
    const running = await seedJob("job_running000001", {
      status: "pending",
      updatedAt: ago(40 * DAY),
      progress: 40,
      output: null,
    });

    const result = await sweepRetention({ nowMs: NOW, retentionDays: 30 });

    expect(result).toEqual({ purged: 0, failed: 0 });
    expect(await exists(fresh.outputs)).toBe(true);
    expect(await exists(running.outputs)).toBe(true);
    expect((await readJob("job_running000001"))?.artifactsPurgedAt).toBeUndefined();
  });

  it("does not purge a second time", async () => {
    await seedJob("job_twice00000001", { artifactsPurgedAt: ago(2 * DAY) });

    expect(await sweepRetention({ nowMs: NOW, retentionDays: 30 })).toEqual({ purged: 0, failed: 0 });
    expect((await readJob("job_twice00000001"))?.artifactsPurgedAt).toBe(ago(2 * DAY));
  });

  it("does nothing when DATA_RETENTION_DAYS is 0", async () => {
    const { outputs } = await seedJob("job_kept00000001");
    process.env.DATA_RETENTION_DAYS = "0";

    expect(await sweepRetention({ nowMs: NOW })).toEqual({ purged: 0, failed: 0 });
    expect(await exists(outputs)).toBe(true);
    expect((await readJob("job_kept00000001"))?.artifactsPurgedAt).toBeUndefined();
  });

  it("back-fills completedAt on a legacy record so the quota keeps it out of today", async () => {
    const settled = ago(40 * DAY);
    // Written before `completedAt` existed: its finish time lives only in updatedAt.
    await seedJob("job_legacy0000001", { updatedAt: settled, createdAt: settled });

    await sweepRetention({ nowMs: NOW, retentionDays: 30 });

    const rec = await readJob("job_legacy0000001");
    expect(rec?.completedAt).toBe(settled);
    // The stamp write necessarily refreshes updatedAt — which is exactly why the
    // back-fill has to happen in the same write.
    expect(Date.parse(rec!.updatedAt)).toBeGreaterThan(Date.parse(settled));

    const usage = computeQuotaUsage([rec!], OWNER, NOW, { limit: 10, failureLimit: 30 });
    expect(usage).toMatchObject({ used: 0, inFlight: 0, remaining: 10 });
  });

  it("logs a broken record and finishes the round", async () => {
    // job.json says one id, the directory is named another: `updateJob` cannot find
    // the record it was handed. Stands in for any half-written or hand-edited file.
    await seedJob("job_ghost00000001", {}, { dirName: "job_orphan0000001" });
    const good = await seedJob("job_after00000001");

    const result = await sweepRetention({ nowMs: NOW, retentionDays: 30 });

    expect(result).toEqual({ purged: 1, failed: 1 });
    expect(await exists(good.outputs)).toBe(false);
    expect((await readJob("job_after00000001"))?.artifactsPurgedAt).toBe(new Date(NOW).toISOString());
    // The broken record keeps its file: nothing claims it was cleaned.
    const raw = JSON.parse(
      await readFile(path.join(dataRoot, "jobs", "job_orphan0000001", "job.json"), "utf8"),
    ) as JobRecord;
    expect(raw.artifactsPurgedAt).toBeUndefined();
  });
});
