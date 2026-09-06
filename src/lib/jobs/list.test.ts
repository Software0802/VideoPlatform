import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "./schema";

/**
 * `listJobsPage` (方案 `docs/plan-frontend-backend-adaptation.md` §1.4「作品分页」):
 * 严格早于游标、按 `createdAt` 倒序、`kind` 归类。分页边界的关键规则——同一 `createdAt`
 * 的一组记录永远整组出现在同一页，不会被切开——是这份测试最想钉住的地方,因为它比
 * "翻页翻得动"更容易被后续重构悄悄破坏。
 */

let dataRoot = "";
let writeJob: typeof import("./store").writeJob;
let listJobsPage: typeof import("./list").listJobsPage;
let jobKind: typeof import("./list").jobKind;
let clampPageLimit: typeof import("./list").clampPageLimit;
let DEFAULT_PAGE_LIMIT: number;
let MAX_PAGE_LIMIT: number;

const OWNER = "usr_00000000000000a1";

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-list-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = "list-test-session-secret-0123456789";
  ({ writeJob } = await import("./store"));
  ({ listJobsPage, jobKind, clampPageLimit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } = await import("./list"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

let seq = 0;
function baseJob(over: Partial<JobRecord> = {}): JobRecord {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_list_${String(seq).padStart(6, "0")}`,
    ownerId: OWNER,
    status: "succeeded",
    progress: 100,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt: `作品 ${seq}`,
    durationSec: 0,
    aspectRatio: "16:9",
    resolution: null,
    imageResolution: "1k",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    priceCny: 0.5,
    costUsdEstimate: 0.02,
    costUsdActual: 0.02,
    error: null,
    output: { kind: "image", imageUrl: `/api/media/job_list_${seq}/image.jpg` },
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
}

/** Seeds `count` jobs, `stepMs` apart, oldest first in call order but newest overall
 * (each subsequent call gets a later `createdAt`). Returns them oldest-to-newest. */
async function seedSeries(
  ownerId: string,
  count: number,
  opts: { startMs?: number; stepMs?: number; over?: (i: number) => Partial<JobRecord> } = {},
): Promise<JobRecord[]> {
  const startMs = opts.startMs ?? Date.parse("2026-01-01T00:00:00.000Z");
  const stepMs = opts.stepMs ?? 1000;
  const out: JobRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const createdAt = new Date(startMs + i * stepMs).toISOString();
    out.push(await writeJob(baseJob({ ownerId, createdAt, ...(opts.over?.(i) ?? {}) })));
  }
  return out;
}

describe("clampPageLimit", () => {
  it("defaults when undefined, non-finite, zero or negative", () => {
    expect(clampPageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(-5)).toBe(1);
  });

  it("floors a fractional value and caps at MAX_PAGE_LIMIT", () => {
    expect(clampPageLimit(10.9)).toBe(10);
    expect(clampPageLimit(1000)).toBe(MAX_PAGE_LIMIT);
  });
});

describe("jobKind", () => {
  it("classifies by the real output kind once one exists, regardless of mode", () => {
    expect(jobKind({ mode: "text_to_video", output: { kind: "image", imageUrl: "x" } })).toBe("image");
    expect(
      jobKind({
        mode: "text_to_image",
        output: { kind: "video", videoUrl: "x", posterUrl: "", durationSec: 1 },
      }),
    ).toBe("video");
  });

  it("falls back to mode while there is no output yet (queued / failed)", () => {
    expect(jobKind({ mode: "text_to_image", output: null })).toBe("image");
    expect(jobKind({ mode: "text_to_video", output: null })).toBe("video");
    expect(jobKind({ mode: "image_to_video", output: null })).toBe("video");
  });
});

describe("listJobsPage — ordering, ownership and cursor", () => {
  it("returns everything, newest first, with no nextBefore when under the limit", async () => {
    const owner = `${OWNER}`;
    const jobs = await seedSeries(owner, 3);
    const page = await listJobsPage(owner);
    expect(page.jobs.map((j) => j.id)).toEqual([jobs[2].id, jobs[1].id, jobs[0].id]);
    expect(page.nextBefore).toBeUndefined();
  });

  it("never returns another owner's jobs", async () => {
    const mine = "usr_0000000000c0ffee";
    const theirs = "usr_0000000000decaf1";
    const [job] = await seedSeries(mine, 1);
    await seedSeries(theirs, 3);

    const page = await listJobsPage(mine);
    expect(page.jobs.map((j) => j.id)).toEqual([job.id]);
  });

  it("paginates cleanly across pages with no gap and no overlap", async () => {
    const owner = "usr_0000000000d0d0d1";
    const jobs = await seedSeries(owner, 7); // oldest -> newest
    const newestFirst = [...jobs].reverse();

    const page1 = await listJobsPage(owner, { limit: 3 });
    expect(page1.jobs.map((j) => j.id)).toEqual(newestFirst.slice(0, 3).map((j) => j.id));
    expect(page1.nextBefore).toBe(newestFirst[2].createdAt);

    const page2 = await listJobsPage(owner, { limit: 3, before: page1.nextBefore });
    expect(page2.jobs.map((j) => j.id)).toEqual(newestFirst.slice(3, 6).map((j) => j.id));
    expect(page2.nextBefore).toBe(newestFirst[5].createdAt);

    const page3 = await listJobsPage(owner, { limit: 3, before: page2.nextBefore });
    expect(page3.jobs.map((j) => j.id)).toEqual(newestFirst.slice(6, 7).map((j) => j.id));
    expect(page3.nextBefore).toBeUndefined();
  });

  it("keeps a group that shares one createdAt together on the same page instead of splitting it", async () => {
    const owner = "usr_0000000000e0e0e1";
    const tie = "2026-02-01T00:00:00.000Z";
    // Three jobs created in the same millisecond (a batch "count 1-4" submission can do
    // this for real), plus one strictly older job that must land on page 2.
    const tied = await Promise.all(
      [0, 1, 2].map((i) => writeJob(baseJob({ ownerId: owner, id: `job_tie_${i}`, createdAt: tie }))),
    );
    const older = await writeJob(
      baseJob({ ownerId: owner, id: "job_tie_older", createdAt: "2026-01-31T00:00:00.000Z" }),
    );

    // limit=1 would normally cut the boundary inside the tied group; the implementation
    // must widen the page to keep all three together rather than returning just one.
    const page1 = await listJobsPage(owner, { limit: 1 });
    expect(new Set(page1.jobs.map((j) => j.id))).toEqual(new Set(tied.map((j) => j.id)));
    expect(page1.jobs).toHaveLength(3);
    // There IS more after the tied group, so nextBefore must be set …
    expect(page1.nextBefore).toBe(tie);

    // … and asking strictly-before that instant must skip the whole group, not
    // re-serve any of its members.
    const page2 = await listJobsPage(owner, { limit: 1, before: page1.nextBefore });
    expect(page2.jobs.map((j) => j.id)).toEqual([older.id]);
    expect(page2.nextBefore).toBeUndefined();
  });

  it("filters by kind using the same classification as jobKind", async () => {
    const owner = "usr_0000000000f0f0f1";
    const image = await writeJob(
      baseJob({ ownerId: owner, id: "job_kind_image", mode: "text_to_image", createdAt: "2026-03-01T00:00:00.000Z" }),
    );
    const video = await writeJob(
      baseJob({
        ownerId: owner,
        id: "job_kind_video",
        mode: "text_to_video",
        durationSec: 5,
        createdAt: "2026-03-02T00:00:00.000Z",
        output: { kind: "video", videoUrl: "/x.mp4", posterUrl: "/x.jpg", durationSec: 5 },
      }),
    );

    expect((await listJobsPage(owner, { kind: "image" })).jobs.map((j) => j.id)).toEqual([image.id]);
    expect((await listJobsPage(owner, { kind: "video" })).jobs.map((j) => j.id)).toEqual([video.id]);
  });

  it("treats an unparseable before cursor as no cursor at all, rather than filtering everything out", async () => {
    const owner = "usr_0000000000111111";
    const jobs = await seedSeries(owner, 2);
    const page = await listJobsPage(owner, { before: "not-a-real-date" });
    expect(page.jobs.map((j) => j.id)).toEqual([jobs[1].id, jobs[0].id]);
  });

  it("skips a record with a corrupt createdAt once a cursor is active, but still shows it on the first page", async () => {
    const owner = "usr_0000000000222222";
    const good = await writeJob(
      baseJob({ ownerId: owner, id: "job_good", createdAt: "2026-04-01T00:00:00.000Z" }),
    );
    const corrupt = await writeJob(baseJob({ ownerId: owner, id: "job_corrupt", createdAt: "not-a-date" }));

    const firstPage = await listJobsPage(owner);
    expect(new Set(firstPage.jobs.map((j) => j.id))).toEqual(new Set([good.id, corrupt.id]));

    const cursored = await listJobsPage(owner, { before: "2026-05-01T00:00:00.000Z" });
    expect(cursored.jobs.map((j) => j.id)).toEqual([good.id]);
  });
});
