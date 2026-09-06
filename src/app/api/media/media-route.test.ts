import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "@/lib/jobs/schema";
import type { UserRecord } from "@/lib/users/schema";

/**
 * Caching on `GET /api/media/:jobId/:file` (plan §3.3, P3): a `private, no-cache`
 * Cache-Control, a weak size+mtime ETag, and an `If-None-Match` hit answered with a
 * bodyless 304 — see `src/app/api/media/[jobId]/[file]/route.ts`. The owner check that
 * already guarded this route (plan §5.1: a guessable job id must 404, never leak
 * another user's bytes) has to keep holding with the new headers layered on, so that
 * hard constraint gets its own assertions here rather than being assumed unaffected.
 *
 * `no-cache` rather than `immutable` is itself an ownership rule: a stored response the
 * browser may reuse without asking would outlive the session that was allowed to see it,
 * so a second account on the same browser would read the first account's footage out of
 * the local cache with no request to authorize. The revalidation-with-ETag test below is
 * what pins that down — a 304 must still be earned by the owner check.
 */
const CACHE_CONTROL = "private, no-cache";

const SESSION_SECRET = "media-route-test-secret-0123456789";

let dataRoot = "";
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let writeUser: typeof import("@/lib/users/store").writeUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;
let GET: typeof import("./[jobId]/[file]/route").GET;
let jobDir: typeof import("@/lib/storage/local-fs").mediaStore.jobDir;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-media-route-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  ({ writeJob } = await import("@/lib/jobs/store"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ GET } = await import("./[jobId]/[file]/route"));
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

async function seedImageJob(jobId: string, ownerId: string, bytes: string): Promise<JobRecord> {
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
    prompt: "缓存测试",
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
  };
  const written = await writeJob(rec);
  const outDir = path.join(jobDir(jobId), "outputs");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "image.jpg"), bytes);
  return written;
}

function requestFor(jobId: string, file: string, user: UserRecord, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/media/${jobId}/${file}`, {
    headers: { cookie: `${SESSION_COOKIE}=${issueSessionValue(user)}`, ...headers },
  });
}

function ctxFor(jobId: string, file: string) {
  return { params: Promise.resolve({ jobId, file }) };
}

describe("GET /api/media/:jobId/:file caching", () => {
  it("200s with a revalidate-every-time private Cache-Control and a weak size+mtime ETag", async () => {
    const owner = await seedUser(userId("1"));
    await seedImageJob("job_media_1", owner.id, "fake-jpeg-bytes");

    const res = await GET(requestFor("job_media_1", "image.jpg", owner), ctxFor("job_media_1", "image.jpg"));

    expect(res.status).toBe(200);
    // No max-age and no `immutable`: a stored copy may never be reused without coming
    // back through the owner check (see the cross-account test below).
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
    expect(res.headers.get("cache-control")).not.toMatch(/max-age|immutable/);
    expect(res.headers.get("etag")).toMatch(/^W\/"\d+-\d+"$/);
  });

  it("answers a matching If-None-Match with a bodyless 304", async () => {
    const owner = await seedUser(userId("2"));
    await seedImageJob("job_media_2", owner.id, "fake-jpeg-bytes");

    const first = await GET(requestFor("job_media_2", "image.jpg", owner), ctxFor("job_media_2", "image.jpg"));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await GET(
      requestFor("job_media_2", "image.jpg", owner, { "if-none-match": etag! }),
      ctxFor("job_media_2", "image.jpg"),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe(CACHE_CONTROL);
    const body = await second.text();
    expect(body).toBe("");
  });

  it("does not 304 a stale If-None-Match — a changed file still serves fresh bytes", async () => {
    const owner = await seedUser(userId("3"));
    await seedImageJob("job_media_3", owner.id, "fake-jpeg-bytes");
    const first = await GET(requestFor("job_media_3", "image.jpg", owner), ctxFor("job_media_3", "image.jpg"));
    const staleEtag = first.headers.get("etag")!;

    const res = await GET(
      requestFor("job_media_3", "image.jpg", owner, { "if-none-match": '"not-the-real-etag"' }),
      ctxFor("job_media_3", "image.jpg"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(staleEtag);
  });

  it("carries the same Cache-Control/ETag on a 206 partial response", async () => {
    const owner = await seedUser(userId("4"));
    await seedImageJob("job_media_4", owner.id, "0123456789");

    const res = await GET(
      requestFor("job_media_4", "image.jpg", owner, { range: "bytes=0-3" }),
      ctxFor("job_media_4", "image.jpg"),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
    expect(res.headers.get("etag")).toMatch(/^W\/"\d+-\d+"$/);
  });

  it("carries the same Cache-Control on a ?download=1 attachment response", async () => {
    const owner = await seedUser(userId("8"));
    await seedImageJob("job_media_7", owner.id, "fake-jpeg-bytes");

    const res = await GET(
      new Request(`http://localhost/api/media/job_media_7/image.jpg?download=1`, {
        headers: { cookie: `${SESSION_COOKIE}=${issueSessionValue(owner)}` },
      }),
      ctxFor("job_media_7", "image.jpg"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL);
  });

  it("keeps the owner check intact: a signed-in stranger gets 404, with no ETag leaked", async () => {
    const owner = await seedUser(userId("5"));
    const stranger = await seedUser(userId("6"));
    await seedImageJob("job_media_5", owner.id, "fake-jpeg-bytes");

    const res = await GET(requestFor("job_media_5", "image.jpg", stranger), ctxFor("job_media_5", "image.jpg"));
    expect(res.status).toBe(404);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("404s a stranger's revalidation of a valid ETag — a 304 is not a shortcut past the owner check", async () => {
    // The cross-account case the `no-cache` header exists for: two accounts share one
    // browser, so account B can end up holding A's validator (from the shared HTTP cache
    // or simply by replaying the header). Revalidation must be answered by ownership
    // first — 404, the same answer an unknown job id gets — never by a 304 that would
    // confirm the file exists and greenlight the locally cached bytes.
    const owner = await seedUser(userId("9"));
    const other = await seedUser(userId("a"));
    await seedImageJob("job_media_8", owner.id, "fake-jpeg-bytes");

    const first = await GET(requestFor("job_media_8", "image.jpg", owner), ctxFor("job_media_8", "image.jpg"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const second = await GET(
      requestFor("job_media_8", "image.jpg", other, { "if-none-match": etag }),
      ctxFor("job_media_8", "image.jpg"),
    );
    expect(second.status).toBe(404);
    expect(second.headers.get("etag")).toBeNull();
  });

  it("refuses an unauthenticated request with 401 rather than a cached file", async () => {
    const owner = await seedUser(userId("7"));
    await seedImageJob("job_media_6", owner.id, "fake-jpeg-bytes");

    const res = await GET(
      new Request("http://localhost/api/media/job_media_6/image.jpg"),
      ctxFor("job_media_6", "image.jpg"),
    );
    expect(res.status).toBe(401);
  });
});
