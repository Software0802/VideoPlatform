import { randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { JobRecord } from "./schema";

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let readJob: typeof import("./store").readJob;
let retryJob: typeof import("./create").retryJob;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-create-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createJob, retryJob } = await import("./create"));
  ({ readJob } = await import("./store"));
  // 余额模型（方案 §3.2）：提交与重试都要先过余额判定，先把测试账号建出来并充够。
  const { writeUser } = await import("@/lib/users/store");
  await writeUser({
    id: TEST_OWNER,
    email: "owner@example.com",
    passwordHash: "scrypt$16384$8$1$00$00",
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("createJob upload claims", () => {
  it("removes the sidecar after moving an upload into the job", async () => {
    const uploadId = "up_aaaaaaaaaaaaaaaa";
    const tmp = path.join(dataRoot, "tmp");
    await mkdir(tmp, { recursive: true });
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(path.join(tmp, uploadId), jpeg);
    await writeFile(
      path.join(tmp, `${uploadId}.json`),
      JSON.stringify({
        uploadId,
        ownerId: TEST_OWNER,
        role: "start",
        width: 2,
        height: 2,
        bytes: jpeg.length,
        mimeType: "image/jpeg",
        durationSec: null,
        createdAt: new Date().toISOString(),
      }),
    );

    const { job } = await createJob(
      {
        mode: "image_to_video",
        prompt: "a slow camera move",
        durationSec: 1,
        startUploadId: uploadId,
      },
      TEST_OWNER,
    );

    await expect(access(path.join(tmp, `${uploadId}.json`))).rejects.toThrow();
    await expect(readFile(path.join(dataRoot, "jobs", job.id, "inputs", "start.jpg"))).resolves.toEqual(jpeg);

    for (let i = 0; i < 12; i += 1) {
      const current = await readJob(job.id);
      if (current?.status === "succeeded" || current?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
});

/**
 * Retention deleted the source job's `inputs/` (plan §8), so a one-click retry has
 * nothing to copy. The refusal is checked before the status rule: a purged job is
 * normally `succeeded`, and "仅失败或过期任务可重试" would point at the wrong problem.
 */
describe("retryJob on a purged job", () => {
  function record(over: Partial<JobRecord> = {}): JobRecord {
    return {
      schemaVersion: 1,
      id: "job_purged000001",
      ownerId: TEST_OWNER,
      status: "succeeded",
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
      priceCny: 0,
      costUsdEstimate: 0.02,
      costUsdActual: 0.02,
      error: null,
      output: { kind: "image", imageUrl: "/api/media/job_purged000001/image.jpg" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:00.000Z",
      artifactsPurgedAt: "2026-09-01T00:00:00.000Z",
      bible: null,
      shots: null,
      assets: {},
      ...over,
    };
  }

  it("answers 409 artifacts_purged and creates nothing", async () => {
    const before = await readdir(path.join(dataRoot, "jobs")).catch(() => [] as string[]);

    await expect(retryJob(record(), TEST_OWNER)).rejects.toMatchObject({
      status: 409,
      code: "artifacts_purged",
      message: "作品已过期清理，请用这条提示词重新生成",
    });

    const after = await readdir(path.join(dataRoot, "jobs")).catch(() => [] as string[]);
    expect(after).toEqual(before);
  });

  it("gives the same answer for a purged failed job, which would otherwise be retryable", async () => {
    const failed = record({
      status: "failed",
      output: null,
      error: { code: "internal", message: "上游炸了" },
    });
    await expect(retryJob(failed, TEST_OWNER)).rejects.toMatchObject({ code: "artifacts_purged" });
  });

  it("still refuses an un-purged succeeded job with the plain status conflict", async () => {
    const intact = record({ artifactsPurgedAt: undefined });
    await expect(retryJob(intact, TEST_OWNER)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
  });
});

/**
 * Balance admission (方案 §3.2): the balance gate runs inside the same
 * `withAdmissionLock` critical section as the quota check, right before a fresh
 * job is written. Each test uses its own owner so one test's reservation cannot
 * be mistaken for another's (mirrors `quota-admission.test.ts`'s `owner(tag)`).
 */
describe("createJob balance admission gate", () => {
  function billingOwner(tag: string): string {
    return `usr_${tag.padStart(16, "0")}`;
  }

  async function seedBalance(id: string, balanceCny: number) {
    const { writeUser } = await import("@/lib/users/store");
    return writeUser({
      id,
      email: `${id}@example.com`,
      passwordHash: "hash",
      sessionEpoch: 1,
      plan: "free",
      balanceCny,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** A non-terminal job written straight to job.json, to model an existing reservation
   * without racing the live (unmocked, in this file) runner to completion. */
  async function seedPendingImage(id: string, ownerId: string, priceCny: number) {
    const { writeJob } = await import("./store");
    const now = new Date().toISOString();
    const rec: JobRecord = {
      schemaVersion: 1,
      id,
      ownerId,
      status: "pending",
      progress: 0,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "在途预留",
      durationSec: 0,
      aspectRatio: "16:9",
      resolution: null,
      imageResolution: "1k",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      priceCny,
      costUsdEstimate: 0.02,
      costUsdActual: null,
      error: null,
      output: null,
      createdAt: now,
      updatedAt: now,
      bible: null,
      shots: null,
      assets: {},
    };
    return writeJob(rec);
  }

  it("refuses a submission with 402 insufficient_balance when the balance is 0", async () => {
    const id = billingOwner("d1");
    await seedBalance(id, 0);
    await expect(
      createJob({ mode: "text_to_image", prompt: "没钱" } as Parameters<typeof createJob>[0], id),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance" });
  });

  it("admits a submission the balance covers and stamps its priceCny on the record", async () => {
    const id = billingOwner("d2");
    await seedBalance(id, 10);
    const { job } = await createJob(
      { mode: "text_to_image", prompt: "够钱", imageResolution: "1k" } as Parameters<typeof createJob>[0],
      id,
    );
    // Default price table: 1k image = ¥0.5 (billing/prices.ts).
    expect(job.priceCny).toBe(0.5);
  });

  it("counts an in-flight job's price as reserved: a second submission past the remainder is refused", async () => {
    const id = billingOwner("d3");
    await seedBalance(id, 0.5); // exactly one 1k image, nothing left over
    await seedPendingImage("job_balance_reserved", id, 0.5);

    await expect(
      createJob(
        { mode: "text_to_image", prompt: "第二张", imageResolution: "1k" } as Parameters<typeof createJob>[0],
        id,
      ),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance" });
  });
});

/**
 * These need a real (non-mock) provider selection, so each test flips `LUMEN_FORCE_MOCK`
 * off and points VIDEO_PROVIDER_ORDER at YMan for its own duration. `enqueue()` inside
 * `createJob` fires the real background runner (`pump()`), which would otherwise place a
 * real HTTP call against `https://vip.yman.cc` with a fake key — `global.fetch` is stubbed
 * for the same window so that never happens, and each test drains the job to a terminal
 * status before restoring it (the stub always resolves the poll as "failed" so that happens
 * in one pass, no multi-second polling loop).
 */
describe("createJob provider selection — YMan", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.YMAN_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.LUMEN_FORCE_MOCK = "1";
  });

  // Owner ids must match USER_ID_RE (usr_ + 16 lowercase-hex chars), so the tag has to be
  // hex-safe — mirrors billingOwner() above, with an "e" prefix so these ids can't collide
  // with that describe block's "d"-prefixed owners in the same shared data dir.
  function ymanOwner(tag: string): string {
    return `usr_${tag.padStart(16, "0")}`;
  }

  async function seedBalance(id: string, balanceCny: number) {
    const { writeUser } = await import("@/lib/users/store");
    return writeUser({
      id,
      email: `${id}@example.com`,
      passwordHash: "hash",
      sessionEpoch: 1,
      plan: "free",
      balanceCny,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Stubs fetch to accept the submit POST, then resolve the first poll GET as terminal. */
  function stubYmanUpstream() {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        method === "POST"
          ? { id: "vid_stub", status: "queued" }
          : { id: "vid_stub", status: "failed", error: { message: "stub: no real upstream call" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  /** Polls the job to a terminal status so the background runner has finished with `global.fetch`. */
  async function drain(id: string) {
    for (let i = 0; i < 20; i += 1) {
      const current = await readJob(id);
      if (current && ["succeeded", "failed", "expired"].includes(current.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("records provider yman, the upstream t2v model, a normalized duration and no audio", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanUpstream();
    const owner = ymanOwner("e1");
    await seedBalance(owner, 1000);

    const { job } = await createJob(
      { mode: "text_to_video", prompt: "海上日出，长镜头", durationSec: 4 } as Parameters<typeof createJob>[0],
      owner,
    );

    expect(job.provider).toBe("yman");
    expect(job.model).toBe("minimax-H3 文字"); // /v1/models display name — see yman/catalog.test.ts
    expect(job.durationSec).toBe(5); // 4s rounds up to the 5s tier (catalog.normalizeYmanDuration)
    expect(job.generateAudio).toBe(false);
    expect(job.aspectRatio).toBe("16:9"); // default ratio when the request names none
    expect(job.priceCny).toBeGreaterThan(0);

    await drain(job.id);
  });

  it("switches to the i2v/r2v model and its own duration ladder, keeping a supported explicit ratio", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanUpstream();
    const owner = ymanOwner("e2");
    await seedBalance(owner, 1000);

    const uploadId = `up_${"e2".padStart(16, "0")}`; // UPLOAD_ID_RE: up_ + 16 lowercase-hex chars
    const tmp = path.join(dataRoot, "tmp");
    await mkdir(tmp, { recursive: true });
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 4, g: 5, b: 6 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(path.join(tmp, uploadId), jpeg);
    await writeFile(
      path.join(tmp, `${uploadId}.json`),
      JSON.stringify({
        uploadId,
        ownerId: owner,
        role: "start",
        width: 2,
        height: 2,
        bytes: jpeg.length,
        mimeType: "image/jpeg",
        durationSec: null,
        createdAt: new Date().toISOString(),
      }),
    );

    const { job } = await createJob(
      {
        mode: "image_to_video",
        prompt: "让画面动起来",
        durationSec: 6,
        aspectRatio: "9:16",
        startUploadId: uploadId,
      } as Parameters<typeof createJob>[0],
      owner,
    );

    expect(job.provider).toBe("yman");
    expect(job.model).toBe("minimax-h3-933-图文"); // /v1/models display name — see yman/catalog.test.ts
    expect(job.durationSec).toBe(10); // 6s rounds up to the 10s tier on the ref2v ladder
    expect(job.generateAudio).toBe(false);
    expect(job.aspectRatio).toBe("9:16"); // 9:16 is supported, so it passes through unchanged

    await drain(job.id);
  });

  /**
   * Boundary case: 4:3 isn't in YMan's default t2v/i2v models' ratio list. router.ts's
   * `pickVideoProvider` treats an unsupported ratio as a hard filter (types.ts: "用户选的
   * 画幅是需求，不是建议") rather than something to silently swap out — when YMan is the
   * only configured video provider and it can't serve 4:3, `currentProviderId` throws
   * before a job record (and a price) is ever created.
   */
  it("refuses to create a job for a ratio the only configured provider (YMan) doesn't support", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanUpstream();
    const owner = ymanOwner("e3");
    await seedBalance(owner, 1000);
    const before = await readdir(path.join(dataRoot, "jobs")).catch(() => [] as string[]);

    await expect(
      createJob(
        {
          mode: "text_to_video",
          prompt: "竖版试验",
          durationSec: 5,
          aspectRatio: "4:3",
        } as Parameters<typeof createJob>[0],
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });

    // Refused before any job directory (and thus any priced/billed record) is written.
    const after = await readdir(path.join(dataRoot, "jobs")).catch(() => [] as string[]);
    expect(after).toEqual(before);
  });
});

/** Owner ids for the 契约 A1 blocks below, "f"-prefixed to avoid colliding with the
 * "d"/"e"-prefixed owners used by the balance-admission and YMan blocks above, which
 * share this same file's temporary DATA_DIR. */
function productOwner(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

async function seedProductBalance(id: string, balanceCny: number) {
  const { writeUser } = await import("@/lib/users/store");
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Polls a job to a terminal status so a stubbed `global.fetch` is never left mid-flight
 * once the calling test's `afterEach` unstubs it — same safety rule as the YMan block's
 * local `drain` above, redefined here since that one is out of scope for this block. */
async function drainToTerminal(id: string) {
  for (let i = 0; i < 20; i += 1) {
    const current = await readJob(id);
    if (current && ["succeeded", "failed", "expired"].includes(current.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function stubYmanFetch() {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body =
      method === "POST"
        ? { id: "vid_stub_product", status: "queued" }
        : { id: "vid_stub_product", status: "failed", error: { message: "stub: no real upstream call" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function stubKlingFetch() {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body =
      method === "POST"
        ? { code: 0, data: { id: "kling_stub_product" } }
        : {
            code: 0,
            data: [{ id: "kling_stub_product", status: "failed", message: "stub: no real upstream call" }],
          };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function seedJpegUpload(owner: string, role: "start" | "last" | "reference", seed: number): Promise<string> {
  const uploadId = `up_${randomBytes(8).toString("hex")}`;
  const tmp = path.join(dataRoot, "tmp");
  await mkdir(tmp, { recursive: true });
  const jpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: seed % 255, g: 1, b: 1 } },
  })
    .jpeg()
    .toBuffer();
  await writeFile(path.join(tmp, uploadId), jpeg);
  await writeFile(
    path.join(tmp, `${uploadId}.json`),
    JSON.stringify({
      uploadId,
      ownerId: owner,
      role,
      width: 2,
      height: 2,
      bytes: jpeg.length,
      mimeType: "image/jpeg",
      durationSec: null,
      createdAt: new Date().toISOString(),
    }),
  );
  return uploadId;
}

/**
 * 契约 A1：`createJobBodySchema.model?`（产品 id）。不可用 / 不支持 mode → 400；
 * 指定产品时 `JobRecord.provider/model/product/productName` 由产品决定；未指定时
 * 路由后仍写 `product`（`jobs/schema.ts` 已经加了 `product`/`productName` 字段，
 * 但 `create.ts` 是否已经读 `body.model` 并回填它们，就是这组测试要钉住的）。
 */
describe("createJob — model / product selection (契约 A1)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.YMAN_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.LUMEN_FORCE_MOCK = "1";
  });

  it("rejects an unknown model id with 400 invalid_argument", async () => {
    const id = productOwner("f1");
    await seedProductBalance(id, 1000);
    await expect(
      createJob(
        { mode: "text_to_video", prompt: "p", model: "no-such-product", durationSec: 5 } as Parameters<
          typeof createJob
        >[0],
        id,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects a model that doesn't support the requested mode with 400 (video-grok can't do text_to_image)", async () => {
    const id = productOwner("f2");
    await seedProductBalance(id, 1000);
    await expect(
      createJob(
        { mode: "text_to_image", prompt: "p", model: "video-grok" } as Parameters<typeof createJob>[0],
        id,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("stamps provider/model/product/productName from the selected product when model is specified", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanFetch();
    const id = productOwner("f3");
    await seedProductBalance(id, 1000);

    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "海上日出，长镜头",
        model: "video-fast",
        durationSec: 5,
      } as Parameters<typeof createJob>[0],
      id,
    );

    expect(job.provider).toBe("yman");
    expect(job.product).toBe("video-fast");
    expect(job.productName).toBeTruthy();
    await drainToTerminal(job.id);
  });

  it("still stamps a product when no model is given, based on whichever provider the router picks", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanFetch();
    const id = productOwner("f4");
    await seedProductBalance(id, 1000);

    const { job } = await createJob(
      { mode: "text_to_video", prompt: "海上日出，长镜头", durationSec: 5 } as Parameters<typeof createJob>[0],
      id,
    );

    expect(job.provider).toBe("yman");
    expect(job.product).toBe("video-fast");
    await drainToTerminal(job.id);
  });
});

/**
 * 契约 A1：尾帧只有支持 `supportsLastFrame` 的产品能发——video-fast（yman）不支持，
 * video-standard（kling）支持且固定 1080p。`create.ts` 目前还是「对不支持尾帧的产品
 * 400」这句话尚未接进来的状态，这组测试就是钉住这句话。
 */
describe("createJob — lastUploadId requires a last-frame-capable product (契约 A1)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.YMAN_API_KEY;
    delete process.env.KLING_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.LUMEN_FORCE_MOCK = "1";
  });

  it("rejects lastUploadId for video-fast (yman) — that product doesn't support last-frame locking", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanFetch();
    const id = productOwner("f5");
    await seedProductBalance(id, 1000);
    const startUploadId = await seedJpegUpload(id, "start", 1);
    const lastUploadId = await seedJpegUpload(id, "last", 2);

    await expect(
      createJob(
        {
          mode: "image_to_video",
          prompt: "let it move",
          model: "video-fast",
          startUploadId,
          lastUploadId,
          durationSec: 5,
        } as Parameters<typeof createJob>[0],
        id,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts lastUploadId for video-standard (kling) and records the forced 1080p resolution", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    stubKlingFetch();
    const id = productOwner("f6");
    await seedProductBalance(id, 1000);
    const startUploadId = await seedJpegUpload(id, "start", 3);
    const lastUploadId = await seedJpegUpload(id, "last", 4);

    const { job } = await createJob(
      {
        mode: "image_to_video",
        prompt: "let it move",
        model: "video-standard",
        startUploadId,
        lastUploadId,
        resolution: "720p", // user asked 720p; a last frame must still force 1080p
        durationSec: 5,
      } as Parameters<typeof createJob>[0],
      id,
    );

    expect(job.provider).toBe("kling");
    expect(job.lastFrameStored).toBe(true);
    expect(job.resolution).toBe("1080p");
    await drainToTerminal(job.id);
  });
});

/**
 * 契约 A1：参考图上限从 `capabilities().maxReferenceImages` 判定——grok 7、yman 9。
 * `createJobBodySchema.referenceUploadIds` 的 zod 上限已经放宽到 9（见 schema.ts），
 * 但 `create.ts` 目前对每个 job 都无条件调用 grok 专属的 `assertModeConstraints`
 * （`providers/grok/rest-map.ts`），它自己写死了「参考图最多 7 张」且不看 provider——
 * grok 的 8 张用例今天就应该红（本来就该拒），yman 的 9 张用例目前会被这条无差别的
 * 7 张上限连带挡下，这正是任务书要的「provider 上限由 capabilities().maxReferenceImages
 * 校验」尚未接入之处，见测试报告「源码疑点」。
 */
describe("createJob — reference image cap is per-provider (契约 A1)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.YMAN_API_KEY;
    delete process.env.XAI_API_KEY;
    process.env.LUMEN_FORCE_MOCK = "1";
  });

  it("rejects 8 reference images when routed to grok (grok's own 7-image cap)", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.XAI_API_KEY = "xai-live"; // grok is the fallback for reference_to_video
    const id = productOwner("f7");
    await seedProductBalance(id, 1000);
    const referenceUploadIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) => seedJpegUpload(id, "reference", i)),
    );

    await expect(
      createJob(
        {
          mode: "reference_to_video",
          prompt: "八张参考图",
          referenceUploadIds,
          durationSec: 5,
        } as Parameters<typeof createJob>[0],
        id,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("accepts 9 reference images when routed to yman (its own 9-image cap)", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman";
    process.env.YMAN_API_KEY = "yman-test-key";
    stubYmanFetch();
    const id = productOwner("f8");
    await seedProductBalance(id, 1000);
    const referenceUploadIds = await Promise.all(
      Array.from({ length: 9 }, (_, i) => seedJpegUpload(id, "reference", i)),
    );

    const { job } = await createJob(
      {
        mode: "reference_to_video",
        prompt: "九张参考图",
        referenceUploadIds,
        durationSec: 5,
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("yman");
    await drainToTerminal(job.id);
  });
});

/**
 * 方案 §3.2「安全收口」：`MAX_QUEUED_JOBS_PER_USER`（默认 5）是继全站 `MAX_QUEUED_JOBS`
 * 之后的第二道闸门，挡的是「一个人占满全部执行槽」而不是「实例被压垮」（`create.ts` 的
 * `assertQueueRoom`：先判全站，再判按人）。用一条手写的 `pending` 记录站住这个用户的
 * 唯一名额，而不是先真提交一条再等它跑——这样断言不用跟 mock 的完成速度赛跑。
 */
describe("createJob — per-user in-flight cap (MAX_QUEUED_JOBS_PER_USER, 契约 G7)", () => {
  // USER_ID_RE requires usr_ + exactly 16 lowercase-hex chars; "g" (unlike the
  // "d"/"e"/"f" prefixes the blocks above this one use) is not a hex digit, so the tag
  // has to be hex-encoded rather than merely zero-padded.
  function queueOwner(tag: string): string {
    return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
  }

  async function seedQueueBalance(id: string, balanceCny: number) {
    const { writeUser } = await import("@/lib/users/store");
    return writeUser({
      id,
      email: `${id}@example.com`,
      passwordHash: "hash",
      sessionEpoch: 1,
      plan: "free",
      balanceCny,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** A non-terminal job written straight to job.json, occupying this owner's one slot
   * without racing the (mocked) runner to completion — mirrors seedPendingImage() above. */
  async function seedQueuedSlot(id: string, ownerId: string) {
    const { writeJob } = await import("./store");
    const now = new Date().toISOString();
    const rec: JobRecord = {
      schemaVersion: 1,
      id,
      ownerId,
      status: "pending",
      progress: 0,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "占着这个用户唯一的执行槽",
      durationSec: 0,
      aspectRatio: "16:9",
      resolution: null,
      imageResolution: "1k",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      priceCny: 0,
      costUsdEstimate: 0.02,
      costUsdActual: null,
      error: null,
      output: null,
      createdAt: now,
      updatedAt: now,
      bible: null,
      shots: null,
      assets: {},
    };
    return writeJob(rec);
  }

  it("429s queue_full for a second submission once this user's own cap is reached, even though the global cap has room", async () => {
    process.env.MAX_QUEUED_JOBS_PER_USER = "1";
    try {
      const id = queueOwner("g1");
      await seedQueueBalance(id, 1000);
      await seedQueuedSlot("job_queue_cap_g1", id);

      await expect(
        createJob({ mode: "text_to_image", prompt: "第二条" } as Parameters<typeof createJob>[0], id),
      ).rejects.toMatchObject({ status: 429, code: "queue_full" });
    } finally {
      delete process.env.MAX_QUEUED_JOBS_PER_USER;
    }
  });

  it("is scoped per user: a different user is unaffected by the first user's cap", async () => {
    process.env.MAX_QUEUED_JOBS_PER_USER = "1";
    try {
      const busy = queueOwner("g2");
      const free = queueOwner("g3");
      await seedQueueBalance(busy, 1000);
      await seedQueueBalance(free, 1000);
      await seedQueuedSlot("job_queue_cap_g2", busy);

      await expect(
        createJob({ mode: "text_to_image", prompt: "占满" } as Parameters<typeof createJob>[0], busy),
      ).rejects.toMatchObject({ status: 429, code: "queue_full" });

      // A completely different, otherwise-idle user must still be admitted.
      const { job } = await createJob(
        { mode: "text_to_image", prompt: "没占用" } as Parameters<typeof createJob>[0],
        free,
      );
      expect((await readJob(job.id))?.ownerId).toBe(free);
      await drainToTerminal(job.id);
    } finally {
      delete process.env.MAX_QUEUED_JOBS_PER_USER;
    }
  });

  it("frees the slot once the in-flight job reaches a terminal status", async () => {
    process.env.MAX_QUEUED_JOBS_PER_USER = "1";
    try {
      const id = queueOwner("g4");
      await seedQueueBalance(id, 1000);
      const held = await seedQueuedSlot("job_queue_cap_g4", id);

      await expect(
        createJob({ mode: "text_to_image", prompt: "还占着" } as Parameters<typeof createJob>[0], id),
      ).rejects.toMatchObject({ status: 429, code: "queue_full" });

      const { updateJob } = await import("./store");
      await updateJob(held.id, (r) => {
        r.status = "canceled";
        r.canceled = true;
        return r;
      });

      const { job } = await createJob(
        { mode: "text_to_image", prompt: "槽位放出来了" } as Parameters<typeof createJob>[0],
        id,
      );
      expect(job.id).not.toBe(held.id);
      await drainToTerminal(job.id);
    } finally {
      delete process.env.MAX_QUEUED_JOBS_PER_USER;
    }
  });
});

/**
 * 长片（harness）只归一非时长字段：30/45/60 是管线目标总长，provider 的时长档归一
 * 会把它压成一段 clip 的长度；但分辨率 / 音轨 / 画幅仍按 provider 能力归一
 * （harnessSettingsFor，provider-settings.ts）。这里钉住「可灵 + 480p 请求 + 30s」：
 * 记录留住 30 与 harness 标记，resolution 被抬到可灵出得了的 720p。
 */
describe("createJob — harness keeps target duration, still normalizes resolution", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.KLING_API_KEY;
    delete process.env.HARNESS_ENABLED;
    process.env.LUMEN_FORCE_MOCK = "1";
  });

  function harnessOwner(tag: string): string {
    return `usr_${tag.padStart(16, "0")}`;
  }

  it("records durationSec 30 / resolution 720p for a 480p request routed to Kling", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.HARNESS_ENABLED = "true";
    stubKlingFetch();
    const id = harnessOwner("b1");
    await seedProductBalance(id, 1000);

    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "雨夜长镜头",
        durationSec: 30,
        resolution: "480p",
        generateAudio: false,
      } as Parameters<typeof createJob>[0],
      id,
    );

    expect(job.provider).toBe("kling");
    expect(job.durationSec).toBe(30); // target length survives — no clip-tier renormalization
    expect(job.resolution).toBe("720p"); // 480p normalizes up to a tier Kling can serve
    expect(job.generateAudio).toBe(false);
    expect(job.aspectRatio).toBe("16:9");
    expect(job.priceCny).toBeGreaterThan(0);

    await drainToTerminal(job.id);
    const rec = await readJob(job.id);
    expect(rec?.harness?.enabled).toBe(true);
    expect(rec?.durationSec).toBe(30);
  });
});
