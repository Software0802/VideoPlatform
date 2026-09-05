import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mockDirectorPlan } from "@/lib/harness/mock-director";
import { UNCERTAIN_SUBMIT_MESSAGE } from "@/lib/harness/shot-recover";
import { createShotRecords, type HarnessShotRecord } from "@/lib/harness/shot-state";
import { jsonError } from "@/lib/http";
import { ProviderHttpError } from "@/lib/providers/types";
import { jobPublicSchema, type JobPublic, type JobRecord } from "./schema";
import type { RetryBlock } from "./retry-guard";

// Keep the in-process runner out of this test: retryJob enqueues, and a live pump would
// start executing the fresh job against whatever HARNESS_ENABLED happens to be (same
// rationale as retry-harness.test.ts).
vi.mock("@/lib/jobs/runner", () => ({ enqueue: vi.fn(), activeCount: async () => 0 }));

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;
let listJobRecords: () => Promise<JobRecord[]>;
let toPublic: (rec: JobRecord) => JobPublic;
let retryJob: typeof import("./create").retryJob;
let retryBlock: typeof import("./retry-guard").retryBlock;
let UNCERTAIN_SUBMIT_CODE: typeof import("./retry-guard").UNCERTAIN_SUBMIT_CODE;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-retry-guard-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob, listJobRecords, toPublic } = await import("./store"));
  ({ retryJob } = await import("./create"));
  ({ retryBlock, UNCERTAIN_SUBMIT_CODE } = await import("./retry-guard"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

const NOW = "2026-09-05T00:00:00.000Z";

/** Minimal, schema-valid JobRecord so each test only overrides what it cares about. */
function baseRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    schemaVersion: 1,
    id: "job_base",
    status: "failed",
    progress: 0,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "测试",
    durationSec: 30,
    aspectRatio: "16:9",
    resolution: "720p",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    costUsdEstimate: 1,
    costUsdActual: null,
    imageResolution: null,
    error: null,
    output: null,
    createdAt: NOW,
    updatedAt: NOW,
    bible: null,
    shots: null,
    assets: {},
    ...overrides,
  };
}

function uncertainShot(index: number, overrides: Partial<HarnessShotRecord> = {}): HarnessShotRecord {
  return {
    id: `shot_${index}`,
    index,
    status: "needs_review",
    retries: 1,
    costUsd: 0.3,
    error: { code: "uncertain_submit", message: UNCERTAIN_SUBMIT_MESSAGE },
    ...overrides,
  };
}

function okShot(index: number, overrides: Partial<HarnessShotRecord> = {}): HarnessShotRecord {
  return {
    id: `shot_${index}`,
    index,
    status: "succeeded",
    retries: 0,
    costUsd: 1,
    outputPath: `shots/${index}/video.mp4`,
    ...overrides,
  };
}

function otherFailureShot(index: number, code: string, overrides: Partial<HarnessShotRecord> = {}): HarnessShotRecord {
  return {
    id: `shot_${index}`,
    index,
    status: "needs_review",
    retries: 2,
    costUsd: 0.4,
    error: { code, message: "x" },
    ...overrides,
  };
}

describe("retryBlock", () => {
  it("returns null for a native job (no harnessShots field at all)", () => {
    expect(retryBlock(baseRecord())).toBeNull();
    expect(retryBlock(baseRecord({ harnessShots: null }))).toBeNull();
  });

  it("returns null when no shot carries an uncertain_submit error", () => {
    const rec = baseRecord({
      harness: { enabled: true },
      harnessShots: [okShot(0), otherFailureShot(1, "retry_exhausted"), otherFailureShot(2, "qc_visual")],
    });
    expect(retryBlock(rec)).toBeNull();
    // Boundary: an empty shot list (never produced by createShotRecords, but defend anyway).
    expect(retryBlock(baseRecord({ harness: { enabled: true }, harnessShots: [] }))).toBeNull();
  });

  it("ignores a job-level error even when its own code is uncertain_submit", () => {
    const rec = baseRecord({
      harness: { enabled: true },
      // Job-level error deliberately reuses the code string; only shot-level errors should count.
      error: { code: "uncertain_submit", message: "job 级别，不应被读取" },
      harnessShots: [okShot(0), otherFailureShot(1, "retry_exhausted")],
    });
    expect(retryBlock(rec)).toBeNull();
  });

  it("flags every uncertain_submit shot, sorted ascending, regardless of input order or shot status", () => {
    const rec = baseRecord({
      harness: { enabled: true },
      harnessShots: [
        // Deliberately out of index order, and one of the two matches has status "failed"
        // rather than "needs_review" — the contract says only error.code matters.
        uncertainShot(3),
        okShot(0),
        uncertainShot(1, { status: "failed" }),
        otherFailureShot(2, "retry_exhausted"),
      ],
    });
    const block: RetryBlock | null = retryBlock(rec);
    expect(block).not.toBeNull();
    expect(block?.code).toBe(UNCERTAIN_SUBMIT_CODE);
    expect(block?.shotIndexes).toEqual([1, 3]);
    expect(typeof block?.message).toBe("string");
    expect(block?.message.length).toBeGreaterThan(0);
    expect(/[一-龥]/.test(block?.message ?? "")).toBe(true);
    // Message names the flagged shots by their 1-based number (index + 1 = 2 and 4).
    expect(block?.message).toContain("2");
    expect(block?.message).toContain("4");
  });
});

describe("UNCERTAIN_SUBMIT_CODE", () => {
  it("is the literal shot error code produced by recoverHarnessShot", () => {
    expect(UNCERTAIN_SUBMIT_CODE).toBe("uncertain_submit");
  });
});

describe("retryJob blocks retrying an uncertain_submit harness job", () => {
  it("rejects with 409 retry_blocked and writes no new job", async () => {
    const plan = mockDirectorPlan({ prompt: "雪山之巅", targetDurationSec: 30 });
    const shots = createShotRecords(plan.shots);
    const source: JobRecord = baseRecord({
      id: "job_src_blocked",
      mode: "text_to_video",
      durationSec: 30,
      harness: { enabled: true },
      costUsdEstimate: 2.1,
      costUsdPlanned: 2.4,
      costUsdActual: 1.2,
      error: { code: "needs_review", message: "镜头 2/2 需要人工复核" },
      harnessPlan: plan,
      harnessShots: [
        { ...shots[0]!, status: "succeeded", outputPath: "shots/0/video.mp4", costUsd: 1.2 },
        { ...shots[1]!, status: "needs_review", retries: 1, costUsd: 0.5, error: { code: "uncertain_submit", message: UNCERTAIN_SUBMIT_MESSAGE } },
      ],
    });
    await writeJob(source);

    const before = (await listJobRecords()).map((r) => r.id).sort();
    let caught: unknown;
    try {
      await retryJob(source, TEST_OWNER);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderHttpError);
    expect(caught).toMatchObject({ status: 409, code: "retry_blocked" });

    const after = (await listJobRecords()).map((r) => r.id).sort();
    expect(after).toEqual(before);
  });

  it("does not misfire once the shot's error code is no longer uncertain_submit", async () => {
    const plan = mockDirectorPlan({ prompt: "雪山之巅", targetDurationSec: 30 });
    const shots = createShotRecords(plan.shots);
    const source: JobRecord = baseRecord({
      id: "job_src_allowed",
      mode: "text_to_video",
      durationSec: 30,
      harness: { enabled: true },
      costUsdEstimate: 2.1,
      costUsdPlanned: 2.4,
      costUsdActual: 1.2,
      error: { code: "needs_review", message: "镜头 2/2 需要人工复核" },
      harnessPlan: plan,
      harnessShots: [
        { ...shots[0]!, status: "succeeded", outputPath: "shots/0/video.mp4", costUsd: 1.2 },
        { ...shots[1]!, status: "needs_review", retries: 1, costUsd: 0.5, error: { code: "qc_visual", message: "视觉质检未通过" } },
      ],
    });
    await writeJob(source);
    // The kept shot is booked as "succeeded" with an outputPath, and create.ts now verifies
    // that clip actually exists on disk before letting the retry through (retry_copy_failed
    // otherwise) — so the fixture must really have the file, not just claim it in harnessShots.
    await mkdir(path.join(dataRoot, "jobs", "job_src_allowed", "shots", "0"), { recursive: true });
    await writeFile(path.join(dataRoot, "jobs", "job_src_allowed", "shots", "0", "video.mp4"), "clip");

    const next = await retryJob(source, TEST_OWNER);
    expect(next.status).toBe("queued");
    const retried = await readJob(next.id);
    expect(retried?.harnessShots?.map((s) => s.status)).toEqual(["succeeded", "queued"]);
  });
});

describe("toPublic exposes retryBlocked", () => {
  it("is null for a native job", () => {
    const rec = baseRecord({ id: "job_pub_native" });
    expect(toPublic(rec).retryBlocked).toBeNull();
  });

  it("is null for a harness job with no uncertain_submit shots", () => {
    const rec = baseRecord({
      id: "job_pub_clean",
      harness: { enabled: true },
      harnessShots: [okShot(0), otherFailureShot(1, "retry_exhausted")],
    });
    expect(toPublic(rec).retryBlocked).toBeNull();
  });

  it("deep-equals retryBlock(rec) for a harness job with an uncertain_submit shot, and still parses under jobPublicSchema", () => {
    const rec = baseRecord({
      id: "job_pub_hit",
      harness: { enabled: true },
      harnessShots: [okShot(0), uncertainShot(1)],
    });
    const pub = toPublic(rec);
    const expected = retryBlock(rec);
    expect(expected).not.toBeNull();
    expect(pub.retryBlocked).toEqual(expected);
    expect(() => jobPublicSchema.parse(pub)).not.toThrow();
  });
});

describe("jsonError maps retry_blocked", () => {
  it("serializes ProviderHttpError(409, retry_blocked) into a matching JSON response", async () => {
    const res = jsonError(new ProviderHttpError(409, "retry_blocked", "x"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "retry_blocked", message: "x" } });
  });
});
