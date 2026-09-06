import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { JobRecord } from "@/lib/jobs/schema";
import type { UserRecord } from "@/lib/users/schema";

/**
 * 契约 A2：`POST /api/uploads/from-job` 把调用者自己一条成功的图片任务产物复制成
 * 一次普通上传（方案 §1.4「素材选择弹窗」）。只接受本人 succeeded 图片任务、未清理；
 * 跨用户与不存在的任务给同一个 404。写法照抄 `src/app/api/media/media-route.test.ts`
 * 直接调用路由 handler 的风格（同一套 session cookie 构造），而不是走真实 HTTP。
 */

const SESSION_SECRET = "uploads-from-job-test-secret-0123456789";

let dataRoot = "";
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let tmpDir: typeof import("@/lib/jobs/store").tmpDir;
let writeUser: typeof import("@/lib/users/store").writeUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;
let POST: typeof import("./route").POST;
let jobDir: typeof import("@/lib/storage/local-fs").mediaStore.jobDir;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-from-job-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  ({ writeJob, tmpDir } = await import("@/lib/jobs/store"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ POST } = await import("./route"));
  const { mediaStore } = await import("@/lib/storage/local-fs");
  jobDir = mediaStore.jobDir.bind(mediaStore);
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

async function seedUser(id: string): Promise<UserRecord> {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function seedImageJob(
  jobId: string,
  ownerId: string,
  over: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const now = new Date().toISOString();
  const rec: JobRecord = {
    schemaVersion: 1,
    id: jobId,
    ownerId,
    status: "succeeded",
    progress: 100,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt: "海边灯塔",
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
    output: { kind: "image", imageUrl: `/api/media/${jobId}/image.jpg` },
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
  return writeJob(rec);
}

/** Writes the fixed-position output the route reads from (`outputs/image.jpg`, per
 * `runner.ts`'s destRel — see the route's own `OUTPUT_IMAGE_REL` comment). */
async function writeOutputBytes(jobId: string): Promise<Buffer> {
  const jpeg = await sharp({
    create: { width: 4, height: 3, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  const outDir = path.join(jobDir(jobId), "outputs");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "image.jpg"), jpeg);
  return jpeg;
}

function requestFor(user: UserRecord, body: unknown): Request {
  return new Request("http://localhost/api/uploads/from-job", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${issueSessionValue(user)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/uploads/from-job", () => {
  it("duplicates a succeeded image job's output into a new, claimable upload sidecar", async () => {
    const owner = await seedUser(userId("1"));
    await seedImageJob("job_fj_1", owner.id);
    await writeOutputBytes("job_fj_1");

    const res = await POST(requestFor(owner, { jobId: "job_fj_1", role: "start" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ role: "start", width: 4, height: 3, durationSec: null });
    expect(typeof json.uploadId).toBe("string");
    expect(json.uploadId as string).toMatch(/^up_[0-9a-f]{16}$/);
    expect(typeof json.bytes).toBe("number");

    // The upload is real and owner-stamped like any manual /api/uploads sidecar, so
    // createJob's loadSidecar() can claim it the same way.
    const sidecarRaw = await readFile(path.join(tmpDir(), `${json.uploadId as string}.json`), "utf8");
    expect(JSON.parse(sidecarRaw)).toMatchObject({
      uploadId: json.uploadId,
      ownerId: owner.id,
      role: "start",
    });
  });

  it("accepts role=last, for reuse as a last-frame upload", async () => {
    const owner = await seedUser(userId("2"));
    await seedImageJob("job_fj_2", owner.id);
    await writeOutputBytes("job_fj_2");

    const res = await POST(requestFor(owner, { jobId: "job_fj_2", role: "last" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).role).toBe("last");
  });

  it("404s a stranger's job — cross-user access must be indistinguishable from a missing job", async () => {
    const owner = await seedUser(userId("3"));
    const stranger = await seedUser(userId("4"));
    await seedImageJob("job_fj_3", owner.id);
    await writeOutputBytes("job_fj_3");

    const res = await POST(requestFor(stranger, { jobId: "job_fj_3", role: "start" }));
    expect(res.status).toBe(404);
  });

  it("404s a job id that doesn't exist at all", async () => {
    const owner = await seedUser(userId("5"));
    const res = await POST(requestFor(owner, { jobId: "job_fj_does_not_exist", role: "start" }));
    expect(res.status).toBe(404);
  });

  it("rejects a non-succeeded job (e.g. failed) with 400 invalid_argument", async () => {
    const owner = await seedUser(userId("6"));
    await seedImageJob("job_fj_6", owner.id, {
      status: "failed",
      output: null,
      error: { code: "internal", message: "上游炸了" },
    });

    const res = await POST(requestFor(owner, { jobId: "job_fj_6", role: "start" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_argument");
  });

  it("rejects a succeeded job whose output is a video, not an image", async () => {
    const owner = await seedUser(userId("7"));
    await seedImageJob("job_fj_7", owner.id, {
      mode: "text_to_video",
      durationSec: 5,
      output: {
        kind: "video",
        videoUrl: "/api/media/job_fj_7/video.mp4",
        posterUrl: "/api/media/job_fj_7/poster.jpg",
        durationSec: 5,
      },
    });

    const res = await POST(requestFor(owner, { jobId: "job_fj_7", role: "start" }));
    expect(res.status).toBe(400);
  });

  it("rejects a purged job with the artifacts_purged code, even though it is otherwise succeeded+image", async () => {
    const owner = await seedUser(userId("8"));
    await seedImageJob("job_fj_8", owner.id, { artifactsPurgedAt: new Date().toISOString() });
    // Deliberately no writeOutputBytes(): a purged job's outputs/ would be gone for real too.

    const res = await POST(requestFor(owner, { jobId: "job_fj_8", role: "start" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("artifacts_purged");
  });

  it("404s when the record says succeeded but the output file is missing on disk", async () => {
    const owner = await seedUser(userId("9"));
    await seedImageJob("job_fj_9", owner.id); // no writeOutputBytes() this time

    const res = await POST(requestFor(owner, { jobId: "job_fj_9", role: "start" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("作品文件不存在");
  });

  it("refuses an unauthenticated request with 401", async () => {
    const res = await POST(
      new Request("http://localhost/api/uploads/from-job", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "job_fj_1", role: "start" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body — missing jobId, or a role this route doesn't serve — with 400", async () => {
    const owner = await seedUser(userId("a"));

    const missingJobId = await POST(requestFor(owner, { role: "start" }));
    expect(missingJobId.status).toBe(400);

    // source_video is a valid UploadRole elsewhere but this route only ever moves images.
    const badRole = await POST(requestFor(owner, { jobId: "job_fj_1", role: "source_video" }));
    expect(badRole.status).toBe(400);
  });
});
