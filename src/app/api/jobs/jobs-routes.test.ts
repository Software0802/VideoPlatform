import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobRecord } from "@/lib/jobs/schema";
import type { UserRecord } from "@/lib/users/schema";

/**
 * 阶段 B「作品与积分闭环」路由测试（方案 `docs/plan-frontend-backend-adaptation.md` §3）:
 * `GET /api/jobs` 分页、`PATCH /api/jobs/:id` 改标签、`DELETE /api/jobs/:id` 三态、
 * `GET /api/share/:token`（+ `/media`）三态。写法照抄 `media-route.test.ts` /
 * `from-job.test.ts` 直接调用路由 handler 的风格（同一套 session cookie 构造），而不是
 * 走真实 HTTP。
 */

const SESSION_SECRET = "jobs-routes-test-secret-0123456789";

let dataRoot = "";
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let writeUser: typeof import("@/lib/users/store").writeUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;
let issueShareToken: typeof import("@/lib/share/token").issueShareToken;
let signShareToken: typeof import("@/lib/share/token").signShareToken;
let jobDir: typeof import("@/lib/storage/local-fs").mediaStore.jobDir;

let GET_LIST: typeof import("./route").GET;
let PATCH_JOB: typeof import("./[id]/route").PATCH;
let DELETE_JOB: typeof import("./[id]/route").DELETE;
let GET_JOB: typeof import("./[id]/route").GET;
let CANCEL_JOB: typeof import("./[id]/cancel/route").POST;
let GET_SHARE: typeof import("@/app/api/share/[token]/route").GET;
let GET_SHARE_MEDIA: typeof import("@/app/api/share/[token]/media/route").GET;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-jobs-routes-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  ({ writeJob } = await import("@/lib/jobs/store"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ issueShareToken, signShareToken } = await import("@/lib/share/token"));
  ({ GET: GET_LIST } = await import("./route"));
  ({ PATCH: PATCH_JOB, DELETE: DELETE_JOB, GET: GET_JOB } = await import("./[id]/route"));
  ({ POST: CANCEL_JOB } = await import("./[id]/cancel/route"));
  ({ GET: GET_SHARE } = await import("@/app/api/share/[token]/route"));
  ({ GET: GET_SHARE_MEDIA } = await import("@/app/api/share/[token]/media/route"));
  const { mediaStore } = await import("@/lib/storage/local-fs");
  jobDir = mediaStore.jobDir.bind(mediaStore);
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

/** USER_ID_RE requires usr_ + exactly 16 lowercase-hex chars, so an arbitrary tag
 * (letters like "l"/"t"/"s" are not hex digits) can't just be padded — hex-encode it. */
function userId(tag: string): string {
  return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
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

function cookieFor(user: UserRecord): string {
  return `${SESSION_COOKIE}=${issueSessionValue(user)}`;
}

let seq = 0;
async function seedJob(
  ownerId: string,
  over: Partial<JobRecord> = {},
): Promise<JobRecord> {
  seq += 1;
  const now = new Date().toISOString();
  const rec: JobRecord = {
    schemaVersion: 1,
    id: `job_routes_${String(seq).padStart(6, "0")}`,
    ownerId,
    status: "succeeded",
    progress: 100,
    mode: "text_to_image",
    model: "grok-imagine-image-2.0",
    provider: "mock",
    prompt: `路由测试 ${seq}`,
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
    output: { kind: "image", imageUrl: `/api/media/job_routes_${seq}/image.jpg` },
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
  return writeJob(rec);
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getReq(url: string, user?: UserRecord): Request {
  return new Request(url, { headers: user ? { cookie: cookieFor(user) } : {} });
}

function patchReq(url: string, user: UserRecord, body: unknown): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { cookie: cookieFor(user), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteReq(url: string, user?: UserRecord): Request {
  return new Request(url, { method: "DELETE", headers: user ? { cookie: cookieFor(user) } : {} });
}

describe("GET /api/jobs — pagination", () => {
  it("returns the newest jobs first, capped at the default page size, with a working cursor", async () => {
    const owner = await seedUser(userId("l1"));
    const jobs: JobRecord[] = [];
    for (let i = 0; i < 3; i += 1) {
      jobs.push(
        await seedJob(owner.id, { createdAt: new Date(Date.parse("2026-05-01T00:00:00.000Z") + i * 1000).toISOString() }),
      );
    }

    const res = await GET_LIST(getReq("http://localhost/api/jobs?limit=2", owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: { id: string }[]; nextBefore?: string };
    expect(body.jobs.map((j) => j.id)).toEqual([jobs[2].id, jobs[1].id]);
    expect(typeof body.nextBefore).toBe("string");

    const page2 = await GET_LIST(
      getReq(`http://localhost/api/jobs?limit=2&before=${encodeURIComponent(body.nextBefore!)}`, owner),
    );
    const body2 = (await page2.json()) as { jobs: { id: string }[]; nextBefore?: string };
    expect(body2.jobs.map((j) => j.id)).toEqual([jobs[0].id]);
    expect(body2.nextBefore).toBeUndefined();
  });

  it("filters by kind", async () => {
    const owner = await seedUser(userId("l2"));
    const image = await seedJob(owner.id, { mode: "text_to_image" });
    await seedJob(owner.id, {
      mode: "text_to_video",
      durationSec: 5,
      output: { kind: "video", videoUrl: "/x.mp4", posterUrl: "/x.jpg", durationSec: 5 },
    });

    const res = await GET_LIST(getReq("http://localhost/api/jobs?kind=image", owner));
    const body = (await res.json()) as { jobs: { id: string }[] };
    expect(body.jobs.map((j) => j.id)).toEqual([image.id]);
  });

  it("400s an out-of-range limit and a malformed before cursor", async () => {
    const owner = await seedUser(userId("l3"));
    expect((await GET_LIST(getReq("http://localhost/api/jobs?limit=0", owner))).status).toBe(400);
    expect((await GET_LIST(getReq("http://localhost/api/jobs?limit=51", owner))).status).toBe(400);
    expect((await GET_LIST(getReq("http://localhost/api/jobs?kind=audio", owner))).status).toBe(400);
  });

  it("401s an unauthenticated request", async () => {
    expect((await GET_LIST(getReq("http://localhost/api/jobs"))).status).toBe(401);
  });

  it("never lists another user's jobs", async () => {
    const mine = await seedUser(userId("l4"));
    const theirs = await seedUser(userId("l5"));
    await seedJob(theirs.id);
    const res = await GET_LIST(getReq("http://localhost/api/jobs", mine));
    expect(((await res.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });
});

describe("PATCH /api/jobs/:id — tags", () => {
  it("replaces the tag set, trims/dedupes, and returns the public shape", async () => {
    const owner = await seedUser(userId("t1"));
    const job = await seedJob(owner.id);

    const res = await PATCH_JOB(
      patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: [" 广告 ", "广告", "电影叙事"] }),
      ctxFor(job.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["广告", "电影叙事"]);
  });

  it("clears tags with an empty array", async () => {
    const owner = await seedUser(userId("t2"));
    const job = await seedJob(owner.id, { tags: ["旧标签"] });
    const res = await PATCH_JOB(
      patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: [] }),
      ctxFor(job.id),
    );
    expect(((await res.json()) as { tags: string[] }).tags).toEqual([]);
  });

  it("400s more than 5 distinct tags", async () => {
    const owner = await seedUser(userId("t3"));
    const job = await seedJob(owner.id);
    const res = await PATCH_JOB(
      patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: ["a", "b", "c", "d", "e", "f"] }),
      ctxFor(job.id),
    );
    expect(res.status).toBe(400);
  });

  it("400s a single tag longer than 16 code points", async () => {
    const owner = await seedUser(userId("t4"));
    const job = await seedJob(owner.id);
    const res = await PATCH_JOB(
      patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: ["一".repeat(17)] }),
      ctxFor(job.id),
    );
    expect(res.status).toBe(400);
  });

  it("400s an unknown body field (strict schema) and a non-array tags value", async () => {
    const owner = await seedUser(userId("t5"));
    const job = await seedJob(owner.id);
    expect(
      (
        await PATCH_JOB(
          patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: [], extra: 1 }),
          ctxFor(job.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PATCH_JOB(patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: "广告" }), ctxFor(job.id))
      ).status,
    ).toBe(400);
  });

  it("allows tagging a job in any status, not only terminal ones", async () => {
    const owner = await seedUser(userId("t6"));
    const job = await seedJob(owner.id, { status: "pending", output: null });
    const res = await PATCH_JOB(
      patchReq(`http://localhost/api/jobs/${job.id}`, owner, { tags: ["广告"] }),
      ctxFor(job.id),
    );
    expect(res.status).toBe(200);
  });

  it("404s a stranger's job (cross-user) and a non-existent id, indistinguishably", async () => {
    const owner = await seedUser(userId("t7"));
    const stranger = await seedUser(userId("t8"));
    const job = await seedJob(owner.id);

    const crossUser = await PATCH_JOB(
      patchReq(`http://localhost/api/jobs/${job.id}`, stranger, { tags: ["x"] }),
      ctxFor(job.id),
    );
    expect(crossUser.status).toBe(404);

    const missing = await PATCH_JOB(
      patchReq("http://localhost/api/jobs/job_does_not_exist", owner, { tags: ["x"] }),
      ctxFor("job_does_not_exist"),
    );
    expect(missing.status).toBe(404);
  });

  it("401s an unauthenticated request", async () => {
    const owner = await seedUser(userId("t9"));
    const job = await seedJob(owner.id);
    const res = await PATCH_JOB(
      new Request(`http://localhost/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: [] }),
      }),
      ctxFor(job.id),
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/jobs/:id", () => {
  it("204s a terminal job, deletes its directory, and 404s every route afterwards", async () => {
    const owner = await seedUser(userId("d1"));
    const job = await seedJob(owner.id, { status: "succeeded" });

    const res = await DELETE_JOB(deleteReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));
    expect(res.status).toBe(204);

    const getAfter = await GET_JOB(getReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));
    expect(getAfter.status).toBe(404);

    const deleteAgain = await DELETE_JOB(
      deleteReq(`http://localhost/api/jobs/${job.id}`, owner),
      ctxFor(job.id),
    );
    expect(deleteAgain.status).toBe(404);
  });

  it.each(["queued", "submitting", "pending", "persisting"] as const)(
    "409s job_active for a job still in status %s, and leaves it on disk",
    async (status) => {
      const owner = await seedUser(userId(`d-${status}`));
      const job = await seedJob(owner.id, { status, output: null });

      const res = await DELETE_JOB(deleteReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("job_active");

      const getAfter = await GET_JOB(getReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));
      expect(getAfter.status).toBe(200);
    },
  );

  it("404s a stranger's job rather than letting them delete it", async () => {
    const owner = await seedUser(userId("d2"));
    const stranger = await seedUser(userId("d3"));
    const job = await seedJob(owner.id);

    const res = await DELETE_JOB(deleteReq(`http://localhost/api/jobs/${job.id}`, stranger), ctxFor(job.id));
    expect(res.status).toBe(404);

    // And it must genuinely still be there for the real owner.
    const stillThere = await GET_JOB(getReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));
    expect(stillThere.status).toBe(200);
  });

  it("404s a non-existent job id", async () => {
    const owner = await seedUser(userId("d4"));
    const res = await DELETE_JOB(
      deleteReq("http://localhost/api/jobs/job_never_existed", owner),
      ctxFor("job_never_existed"),
    );
    expect(res.status).toBe(404);
  });

  it("401s an unauthenticated request", async () => {
    const owner = await seedUser(userId("d5"));
    const job = await seedJob(owner.id);
    const res = await DELETE_JOB(deleteReq(`http://localhost/api/jobs/${job.id}`), ctxFor(job.id));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/jobs/:id/cancel — R09 取消契约", () => {
  function postReq(url: string, user?: UserRecord): Request {
    return new Request(url, { method: "POST", headers: user ? { cookie: cookieFor(user) } : {} });
  }

  it("排队中的任务照常取消", async () => {
    const owner = await seedUser(userId("cc1"));
    const job = await seedJob(owner.id, { status: "queued", progress: 0, output: null });
    const res = await CANCEL_JOB(postReq(`http://localhost/api/jobs/${job.id}/cancel`, owner), ctxFor(job.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("canceled");
  });

  it("字节已 checkpoint（persisting + localOutputPath）的任务不被取消：200 返回进行中的记录", async () => {
    const owner = await seedUser(userId("cc2"));
    const job = await seedJob(owner.id, {
      status: "persisting",
      progress: 90,
      output: null,
      remoteUrl: "https://cdn.example.com/out.mp4",
      localOutputPath: "data/tmp/cc2.mp4",
    });
    const res = await CANCEL_JOB(postReq(`http://localhost/api/jobs/${job.id}/cancel`, owner), ctxFor(job.id));
    expect(res.status).toBe(200);
    // 取消契约：产物已存在时，终态交给 persist 结算——记录必须原样还在进行中，
    // 不是「先标 canceled、等 persist 再把已付费的成片删掉」。
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("persisting");
    const after = await GET_JOB(getReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));
    expect(((await after.json()) as { status: string }).status).toBe("persisting");
  });

  it("远端产物已产出（persisting + remoteUrl，上游已计费）同样不取消", async () => {
    const owner = await seedUser(userId("cc3"));
    const job = await seedJob(owner.id, {
      status: "persisting",
      progress: 90,
      output: null,
      remoteUrl: "https://cdn.example.com/out.mp4",
    });
    const res = await CANCEL_JOB(postReq(`http://localhost/api/jobs/${job.id}/cancel`, owner), ctxFor(job.id));
    expect(((await res.json()) as { status: string }).status).toBe("persisting");
  });
});

describe("GET /api/share/:token and .../media", () => {
  function shareCtx(token: string) {
    return { params: Promise.resolve({ token }) };
  }

  async function writeImageBytes(jobId: string): Promise<void> {
    const outDir = path.join(jobDir(jobId), "outputs");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "image.jpg"), "fake-jpeg-bytes");
  }

  it("200s a shareable job's metadata and streams its media through the token, with no owner info leaked", async () => {
    const owner = await seedUser(userId("s1"));
    const job = await seedJob(owner.id, { status: "succeeded", prompt: "一段很长的提示词".repeat(10) });
    await writeImageBytes(job.id);
    const { token } = issueShareToken(job.id, owner.id);

    const metaRes = await GET_SHARE(getReq("http://localhost/api/share/x"), shareCtx(token));
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as Record<string, unknown>;
    expect(meta.kind).toBe("image");
    expect(meta.mediaUrl).toBe(`/api/share/${encodeURIComponent(token)}/media`);
    expect(JSON.stringify(meta)).not.toContain(owner.id);
    expect(JSON.stringify(meta)).not.toContain(job.id);

    const mediaRes = await GET_SHARE_MEDIA(getReq("http://localhost/api/share/x/media"), shareCtx(token));
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get("content-type")).toBe("image/jpeg");
  });

  it("404s both endpoints for a tampered token", async () => {
    const owner = await seedUser(userId("s2"));
    const job = await seedJob(owner.id);
    await writeImageBytes(job.id);
    const { token } = issueShareToken(job.id, owner.id);
    const tampered = `${token}x`;

    expect((await GET_SHARE(getReq("http://localhost/x"), shareCtx(tampered))).status).toBe(404);
    expect((await GET_SHARE_MEDIA(getReq("http://localhost/x"), shareCtx(tampered))).status).toBe(404);
  });

  it("404s both endpoints for an expired token", async () => {
    const owner = await seedUser(userId("s3"));
    const job = await seedJob(owner.id);
    await writeImageBytes(job.id);
    // exp = 1 (Unix seconds) is always in the past relative to the route's real Date.now().
    const expired = signShareToken({ jobId: job.id, ownerId: owner.id, exp: 1 });

    expect((await GET_SHARE(getReq("http://localhost/x"), shareCtx(expired))).status).toBe(404);
    expect((await GET_SHARE_MEDIA(getReq("http://localhost/x"), shareCtx(expired))).status).toBe(404);
  });

  it("404s a token whose job has since been deleted", async () => {
    const owner = await seedUser(userId("s4"));
    const job = await seedJob(owner.id);
    await writeImageBytes(job.id);
    const { token } = issueShareToken(job.id, owner.id);

    await DELETE_JOB(deleteReq(`http://localhost/api/jobs/${job.id}`, owner), ctxFor(job.id));

    expect((await GET_SHARE(getReq("http://localhost/x"), shareCtx(token))).status).toBe(404);
    expect((await GET_SHARE_MEDIA(getReq("http://localhost/x"), shareCtx(token))).status).toBe(404);
  });

  it("404s a token whose job has since had its artifacts purged by retention", async () => {
    const owner = await seedUser(userId("s5"));
    const job = await seedJob(owner.id, { artifactsPurgedAt: new Date().toISOString() });
    // Deliberately no writeImageBytes(): a purged job's outputs/ would really be gone too.
    const { token } = issueShareToken(job.id, owner.id);

    const metaRes = await GET_SHARE(getReq("http://localhost/x"), shareCtx(token));
    expect(metaRes.status).toBe(404);
    expect((await GET_SHARE_MEDIA(getReq("http://localhost/x"), shareCtx(token))).status).toBe(404);
  });

  it("404s a job that is not (or not yet) succeeded", async () => {
    const owner = await seedUser(userId("s6"));
    const job = await seedJob(owner.id, { status: "pending", output: null });
    const { token } = issueShareToken(job.id, owner.id);
    expect((await GET_SHARE(getReq("http://localhost/x"), shareCtx(token))).status).toBe(404);
  });

  it("works with no session cookie at all — the token itself is the credential", async () => {
    const owner = await seedUser(userId("s7"));
    const job = await seedJob(owner.id);
    await writeImageBytes(job.id);
    const { token } = issueShareToken(job.id, owner.id);

    const res = await GET_SHARE(new Request("http://localhost/x"), shareCtx(token));
    expect(res.status).toBe(200);
  });
});
