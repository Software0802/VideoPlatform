import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "./schema";

/**
 * `data/jobs/index.json`（方案 §3.3 P2）。三条纪律见 `index.ts` 头部注释：索引是缓存不是
 * 事实源、写序固定（job.json 先于索引）、读之前先对一次目录名。这份测试按纪律逐条钉：
 * 增量维护（`writeJob` / `updateJob` 在 `store.ts` 里、`deleteJobById` 在 `delete.ts` 里）、
 * 缺失/损坏/条数不符时的重建、以及重建结果与直接扫 `data/jobs/*​/job.json` 完全一致。
 */

let dataRoot = "";
let jobsDirAbs = "";
let writeJob: typeof import("./store").writeJob;
let updateJob: typeof import("./store").updateJob;
let deleteJobById: typeof import("./delete").deleteJobById;
let toIndexEntry: typeof import("./index").toIndexEntry;
let ensureJobIndex: typeof import("./index").ensureJobIndex;
let rebuildJobIndex: typeof import("./index").rebuildJobIndex;
let resetJobIndexCache: typeof import("./index").resetJobIndexCache;
let listJobIndex: typeof import("./index").listJobIndex;
let jobIndexPath: typeof import("./index").jobIndexPath;
let flushJobIndex: typeof import("./index").flushJobIndex;

const OWNER = "usr_00000000000000a1";
const OTHER_OWNER = "usr_00000000000000b2";

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-jobindex-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ writeJob, updateJob } = await import("./store"));
  ({ deleteJobById } = await import("./delete"));
  ({ toIndexEntry, ensureJobIndex, rebuildJobIndex, resetJobIndexCache, listJobIndex, jobIndexPath, flushJobIndex } =
    await import("./index"));
  jobsDirAbs = path.join(dataRoot, "jobs");
});

afterEach(async () => {
  resetJobIndexCache();
  delete process.env.LUMEN_ADMIN_USER_ID;
  await rm(jobsDirAbs, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

let seq = 0;
function job(over: Partial<JobRecord> = {}): JobRecord {
  seq += 1;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_idx_${String(seq).padStart(6, "0")}`,
    ownerId: OWNER,
    status: "pending",
    progress: 10,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt: `索引测试 ${seq}`,
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
    costUsdActual: null,
    error: null,
    output: null,
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
}

/** Ground truth, independent of both `store.ts` and `index.ts`: read every `job.json`
 * straight off disk. Used to prove the index agrees with a real full scan. */
async function fullScanIds(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(jobsDirAbs);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (name === "index.json" || name.endsWith(".tmp")) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(jobsDirAbs, name, "job.json"), "utf8")) as JobRecord;
      ids.push(raw.id);
    } catch {
      // not a job directory
    }
  }
  return ids.sort();
}

describe("toIndexEntry", () => {
  it("carries the required fields and omits optional ones that are absent", () => {
    const rec = job({ ownerId: undefined, completedAt: undefined, artifactsPurgedAt: undefined, output: null });
    const entry = toIndexEntry(rec);
    expect(entry).toMatchObject({ id: rec.id, status: "pending", mode: "text_to_image", priceCny: 0.5 });
    expect("ownerId" in entry).toBe(false);
    expect("completedAt" in entry).toBe(false);
    expect("artifactsPurgedAt" in entry).toBe(false);
    expect("outputKind" in entry).toBe(false);
  });

  it("derives outputKind from output.kind, and falls back to legacy videoUrl/imageUrl shapes", () => {
    expect(toIndexEntry(job({ output: { kind: "image", imageUrl: "/x.jpg" } })).outputKind).toBe("image");
    expect(
      toIndexEntry(job({ output: { kind: "video", videoUrl: "/x.mp4", posterUrl: "", durationSec: 1 } }))
        .outputKind,
    ).toBe("video");
  });

  it("treats a non-finite priceCny as 0 rather than propagating NaN into the index", () => {
    const rec = job({ priceCny: Number.NaN });
    expect(toIndexEntry(rec).priceCny).toBe(0);
  });
});

describe("incremental maintenance via writeJob / updateJob / deleteJobById", () => {
  it("shows a job in listJobIndex immediately after writeJob, before any debounced flush", async () => {
    const rec = await writeJob(job());
    const entries = await listJobIndex({ ownerId: OWNER });
    expect(entries.map((e) => e.id)).toContain(rec.id);
  });

  it("reflects a status change made via updateJob without creating a new job.json directory", async () => {
    const rec = await writeJob(job({ status: "pending" }));
    let entries = await listJobIndex({ ownerId: OWNER, nonTerminal: true });
    expect(entries.map((e) => e.id)).toContain(rec.id);

    await updateJob(rec.id, (r) => {
      r.status = "succeeded";
      r.output = { kind: "image", imageUrl: `/api/media/${rec.id}/image.jpg` };
      return r;
    });

    entries = await listJobIndex({ ownerId: OWNER, nonTerminal: true });
    expect(entries.map((e) => e.id)).not.toContain(rec.id);
    const terminal = await listJobIndex({ ownerId: OWNER, nonTerminal: false });
    expect(terminal.find((e) => e.id === rec.id)?.status).toBe("succeeded");
  });

  it("persists to index.json on flushJobIndex, in a shape keyed by directory name", async () => {
    const rec = await writeJob(job());
    await flushJobIndex();
    const raw = JSON.parse(await readFile(jobIndexPath(), "utf8")) as Record<string, { id: string }>;
    expect(raw[rec.id]?.id).toBe(rec.id);
  });

  it("removes the entry from listJobIndex after deleteJobById, and deletes the directory", async () => {
    const rec = await writeJob(job({ status: "succeeded" }));
    await deleteJobById(rec.id);

    const entries = await listJobIndex({ ownerId: OWNER });
    expect(entries.map((e) => e.id)).not.toContain(rec.id);
    await expect(readFile(path.join(jobsDirAbs, rec.id, "job.json"), "utf8")).rejects.toThrow();
  });
});

/**
 * 删除与写路径共用 `store.withJobLock`（`delete.ts` 的注释说明了为什么）。这一组钉的是
 * 那把锁真的在：删除与并发的 `updateJob`（`PATCH /api/jobs/:id` 改标签走的就是它）之间，
 * 不能出现「目录删掉又被 `mkdir` + 写 job.json 复活」的僵尸任务。
 */
describe("deleteJobById is serialized against updateJob", () => {
  it("leaves no resurrected directory when a delete and a tag update race", async () => {
    const rec = await writeJob(job({ status: "succeeded", tags: [] }));
    const dir = path.join(jobsDirAbs, rec.id);

    // 同一 tick 里发出，两边都不 await——真正撞车的形状。`withJobLock` 是同步入队的，
    // 所以次序是确定的：删除先跑完，更新随后在临界区里读不到记录、干净地抛在 `mkdir`
    // 之前。没有锁时它会挤进删除的中段——要么把目录 `mkdir` + 写回来（僵尸任务），要么
    // 半路炸在原子替换的 rename 上（留下 `.job.json-*.tmp`）；两种都过不了下面这几条。
    const [deleted, updated] = await Promise.allSettled([
      deleteJobById(rec.id),
      updateJob(rec.id, (r) => {
        r.tags = ["风景"];
        return r;
      }),
    ]);

    expect(deleted.status).toBe("fulfilled");
    expect(updated.status).toBe("rejected");
    expect(String(((updated as PromiseRejectedResult).reason as Error).message)).toContain(
      "job not found",
    );
    await expect(readFile(path.join(dir, "job.json"), "utf8")).rejects.toThrow();
    // 整个目录都得没，一个半写的临时文件都不许剩。
    await expect(readdir(dir)).rejects.toThrow();
    expect((await listJobIndex({ ownerId: OWNER })).map((e) => e.id)).not.toContain(rec.id);
    // 索引重建（对目录）之后也不能把它捞回来——目录是事实源，它真的不在了。
    expect(await fullScanIds()).not.toContain(rec.id);
  });

  it("refuses to delete a job that is no longer terminal, re-reading status inside the lock", async () => {
    // 路由拿到的是终态快照，落刀之前任务被 retry 推回 queued：锁内复核必须拦住它，
    // 否则 runner 正写着的目录会被删掉。
    const rec = await writeJob(job({ status: "succeeded" }));
    await updateJob(rec.id, (r) => {
      r.status = "queued";
      return r;
    });

    const reason = await deleteJobById(rec.id).catch((e: unknown) => e);
    expect((reason as { status?: number; code?: string }).status).toBe(409);
    expect((reason as { code?: string }).code).toBe("job_active");
    // 记录与索引都完好。
    expect(JSON.parse(await readFile(path.join(jobsDirAbs, rec.id, "job.json"), "utf8")).id).toBe(rec.id);
    expect((await listJobIndex({ ownerId: OWNER })).map((e) => e.id)).toContain(rec.id);
  });
});

describe("listJobIndex filtering, visibility and ordering", () => {
  it("filters by ownerId exactly, and never leaks another owner's jobs", async () => {
    const mine = await writeJob(job({ ownerId: OWNER }));
    await writeJob(job({ ownerId: OTHER_OWNER }));
    const entries = await listJobIndex({ ownerId: OWNER });
    expect(entries.map((e) => e.id)).toEqual([mine.id]);
  });

  it("applies canAccessJob semantics for forUser: an ownerless job is visible only to the admin", async () => {
    const adminId = "usr_000000000000adde";
    const ownerless = await writeJob(job({ ownerId: undefined }));
    await writeJob(job({ ownerId: OWNER }));

    const asStranger = await listJobIndex({ forUser: OTHER_OWNER });
    expect(asStranger.map((e) => e.id)).not.toContain(ownerless.id);

    process.env.LUMEN_ADMIN_USER_ID = adminId;
    const asAdmin = await listJobIndex({ forUser: adminId });
    expect(asAdmin.map((e) => e.id)).toContain(ownerless.id);
  });

  it("filters by a status set and by nonTerminal", async () => {
    const queued = await writeJob(job({ status: "queued" }));
    const failed = await writeJob(job({ status: "failed" }));
    const succeeded = await writeJob(job({ status: "succeeded" }));

    const queuedOnly = await listJobIndex({ ownerId: OWNER, status: ["queued"] });
    expect(queuedOnly.map((e) => e.id)).toEqual([queued.id]);

    const nonTerminal = await listJobIndex({ ownerId: OWNER, nonTerminal: true });
    expect(nonTerminal.map((e) => e.id)).toEqual([queued.id]);

    const terminal = await listJobIndex({ ownerId: OWNER, nonTerminal: false });
    expect(new Set(terminal.map((e) => e.id))).toEqual(new Set([failed.id, succeeded.id]));
  });

  it("sorts newest createdAt first and truncates to limit", async () => {
    const a = await writeJob(job({ createdAt: "2026-01-01T00:00:00.000Z" }));
    const b = await writeJob(job({ createdAt: "2026-01-02T00:00:00.000Z" }));
    const c = await writeJob(job({ createdAt: "2026-01-03T00:00:00.000Z" }));

    const all = await listJobIndex({ ownerId: OWNER });
    expect(all.map((e) => e.id)).toEqual([c.id, b.id, a.id]);

    const limited = await listJobIndex({ ownerId: OWNER, limit: 2 });
    expect(limited.map((e) => e.id)).toEqual([c.id, b.id]);
  });
});

describe("rebuild: missing, corrupt, or count-mismatched index.json", () => {
  it("rebuilds from job.json files when index.json is entirely missing", async () => {
    const rec = await writeJob(job());
    await flushJobIndex();
    await rm(jobIndexPath(), { force: true });
    resetJobIndexCache();

    await ensureJobIndex();
    const entries = await listJobIndex({ ownerId: OWNER });
    expect(entries.map((e) => e.id)).toEqual([rec.id]);
    // The rebuild must also have written a fresh, valid file back to disk.
    const raw = JSON.parse(await readFile(jobIndexPath(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual([rec.id]);
  });

  it("rebuilds when index.json is not valid JSON", async () => {
    const rec = await writeJob(job());
    await flushJobIndex();
    await writeFile(jobIndexPath(), "{ this is not json", "utf8");
    resetJobIndexCache();

    await ensureJobIndex();
    expect((await listJobIndex({ ownerId: OWNER })).map((e) => e.id)).toEqual([rec.id]);
  });

  it("rebuilds when index.json's entries don't match the schema", async () => {
    const rec = await writeJob(job());
    await flushJobIndex();
    await writeFile(jobIndexPath(), JSON.stringify({ [rec.id]: { garbage: true } }), "utf8");
    resetJobIndexCache();

    await ensureJobIndex();
    expect((await listJobIndex({ ownerId: OWNER })).map((e) => e.id)).toEqual([rec.id]);
  });

  it("rebuilds when index.json's key count doesn't match the jobs on disk (stale/phantom entry)", async () => {
    const real = await writeJob(job());
    await flushJobIndex();
    const stale = JSON.parse(await readFile(jobIndexPath(), "utf8")) as Record<string, unknown>;
    stale.job_phantom_not_on_disk = { ...(stale[real.id] as object), id: "job_phantom_not_on_disk" };
    await writeFile(jobIndexPath(), JSON.stringify(stale), "utf8");
    resetJobIndexCache();

    await ensureJobIndex();
    const ids = (await listJobIndex({ ownerId: OWNER })).map((e) => e.id);
    expect(ids).toEqual([real.id]);
    expect(ids).not.toContain("job_phantom_not_on_disk");
  });

  it("detects a job.json written by hand (bypassing writeJob) on the very next read, without an explicit reset", async () => {
    await writeJob(job());
    // Simulate "someone bypassed the store" (index.ts's own stated rationale for rule 3):
    // write a brand-new job directory directly with fs, never touching upsertJobIndex.
    const handId = "job_handwritten_0001";
    const dir = path.join(jobsDirAbs, handId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job({ id: handId })), "utf8");

    // No resetJobIndexCache() here: the directory-name comparison inside loadIndex()
    // must catch the new directory on its own, every call, not only at cold start.
    const ids = (await listJobIndex({ ownerId: OWNER })).map((e) => e.id);
    expect(ids).toContain(handId);
  });
});

describe("index agrees with a full scan of data/jobs after a mix of writes, updates and deletes", () => {
  it("rebuildJobIndex's ids equal an independent directory scan", async () => {
    const a = await writeJob(job());
    // 终态才删得掉（`deleteJobById` 锁内复核状态），所以这条直接写成 succeeded。
    const b = await writeJob(job({ ownerId: OTHER_OWNER, status: "succeeded" }));
    const c = await writeJob(job({ status: "queued" }));
    await updateJob(c.id, (r) => {
      r.status = "succeeded";
      r.output = { kind: "image", imageUrl: `/api/media/${c.id}/image.jpg` };
      return r;
    });
    await deleteJobById(b.id);

    const rebuilt = await rebuildJobIndex();
    const scanned = await fullScanIds();
    expect(rebuilt.map((e) => e.id).sort()).toEqual(scanned);
    expect(scanned).toEqual([a.id, c.id].sort());
  });
});
