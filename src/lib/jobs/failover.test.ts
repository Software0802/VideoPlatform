import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "./schema";

/**
 * End-to-end for `switchAwayFromExhausted` (`jobs/runner.ts`, not exported): a live runner is
 * driven through `createJob`, with `global.fetch` stubbed so a job's *first* provider answers
 * with a "no credit left" envelope and any provider it switches to answers deterministically.
 *
 * Contract under test (task brief, mirrored in the comments above `switchAwayFromExhausted`):
 *  - a `quota_exhausted` submit failure marks that provider+kind exhausted and moves the job to
 *    the next provider `currentProviderId` would pick — model / duration / resolution / audio
 *    are recomputed for the new provider, and `priceCny` becomes `min(original, recalculated)`;
 *  - if the new provider's normalized duration is *larger* and that would raise the price, the
 *    switch is abandoned instead (the job falls back to the ordinary backoff/fail path);
 *  - if the only reachable next hop is "mock", the switch is abandoned rather than shipping a
 *    watermarked placeholder for a paid request;
 *  - the same mechanism applies to `text_to_image`, via `IMAGE_PROVIDER_ORDER`, and never
 *    touches `priceCny` there (images have no duration/resolution/audio to renormalize).
 */

const TEST_OWNER_PREFIX = "usr_";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let readJob: typeof import("./store").readJob;
let updateJob: typeof import("./store").updateJob;
let isExhausted: typeof import("@/lib/providers/exhaustion").isExhausted;

function owner(tag: string): string {
  return `${TEST_OWNER_PREFIX}${tag.padStart(16, "0")}`;
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

/** Poll job.json until the runner leaves every in-flight status. */
async function waitForSettled(id: string, timeoutMs = 10_000): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readJob(id);
    if (rec && ["succeeded", "failed", "canceled", "expired"].includes(rec.status)) return rec;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} did not settle in ${timeoutMs}ms`);
}

/** Poll job.json until `predicate` is true, without requiring a terminal status. */
async function waitUntil(
  id: string,
  predicate: (rec: JobRecord) => boolean,
  timeoutMs = 10_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readJob(id);
    if (rec && predicate(rec)) return rec;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${id} never matched the predicate within ${timeoutMs}ms`);
}

async function pngBody(width: number, height: number): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 60, b: 120 } },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-failover-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.UPSTREAM_RETRY_BASE_MS = "1";
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createJob } = await import("./create"));
  ({ readJob, updateJob } = await import("./store"));
  ({ isExhausted } = await import("@/lib/providers/exhaustion"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.VIDEO_PROVIDER_ORDER;
  delete process.env.IMAGE_PROVIDER_ORDER;
  delete process.env.KLING_API_KEY;
  delete process.env.YMAN_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KLING_VIDEO_AUDIO;
  delete process.env.KLING_VIDEO_RESOLUTION;
  delete process.env.YMAN_T2V_MODEL;
  process.env.LUMEN_FORCE_MOCK = "1";
  // Exhaustion state is a top-level file next to `jobs/`, independent of any one job — reset
  // it between tests so one test's markExhausted cannot change which provider the *next*
  // test's createJob starts on.
  await rm(path.join(dataRoot, "provider-state.json"), { force: true });
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.UPSTREAM_RETRY_BASE_MS;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("video failover — switches provider and takes the lower recalculated price", () => {
  it("moves a Kling job to YMan on quota_exhausted, dropping priceCny from 7 to the cheaper recalculated 4", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_VIDEO_AUDIO = "native";
    const id = owner("f1");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("klingai.com")) {
        // Kling error envelope 1101/1102 → ProviderHttpError(429, "quota_exhausted")
        // (kling/client.ts's KLING_CODE_MAP), even though the transport status is 200.
        return new Response(JSON.stringify({ code: 1101, message: "积分不足" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("yman.cc")) {
        if (method === "POST") {
          return new Response(JSON.stringify({ id: "vid_failover_ok", status: "queued" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ id: "vid_failover_ok", status: "failed", error: { message: "stub: no real upstream call" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected upstream call in this test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // durationSec: 8 normalizes on Kling (>5s) to the 10s tier; with KLING_VIDEO_AUDIO=native
    // and generateAudio:true, resolveKlingSettings bumps resolution to 1080p too. Original
    // price: table.video["10"]=4 × hd(1.5) + audio(1) = 7 (billing/prices.ts DEFAULT_PRICE_TABLE).
    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "海上日出，长镜头",
        durationSec: 8,
        aspectRatio: "16:9",
        generateAudio: true,
      } as Parameters<typeof createJob>[0],
      id,
    );

    expect(job.provider).toBe("kling");
    expect(job.durationSec).toBe(10);
    expect(job.resolution).toBe("1080p");
    expect(job.generateAudio).toBe(true);
    expect(job.priceCny).toBe(7);

    // Wait for the switch to land: provider flips to yman once switchAwayFromExhausted commits.
    const switched = await waitUntil(job.id, (rec) => rec.provider === "yman");
    expect(switched.model).toBe("minimax-H3 文字"); // yman/catalog.ts display name for the t2v model
    // YMan's only resolution is 720p and providerSettingsFor forces yman audio to "off" (its
    // create-task API has no audio switch) — so the recalculated price is table.video["10"]=4,
    // no hd multiplier, no audio surcharge. min(7, 4) = 4.
    expect(switched.durationSec).toBe(10);
    expect(switched.resolution).toBe("720p");
    expect(switched.generateAudio).toBe(false);
    expect(switched.priceCny).toBe(4);

    expect(isExhausted("kling", "video")).toBe(true);
    expect(isExhausted("yman", "video")).toBe(false);

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("failed"); // the yman stub always answers "failed" — settling here just proves no dangling fetch
    // The switch must never have re-billed a higher price after settling, either.
    expect(settled.priceCny).toBe(4);
  });
});

describe("video failover — refuses to switch when the new tier would cost more", () => {
  it("keeps the job on Kling (unswitched, price unchanged) when YMan's only model needs a bigger, pricier duration tier", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.YMAN_API_KEY = "yman-test-key";
    // "SD2.0 满血" only offers 10/15s tiers (yman/catalog.ts YMAN_MODELS) — a 5s Kling request
    // rounds *up* to 10s on this model, which costs more than the 5s tier it started on.
    process.env.YMAN_T2V_MODEL = "SD2.0 满血";
    const id = owner("f2");
    await seedBalance(id, 1000);

    let klingCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("klingai.com")) {
        klingCalls += 1;
        return new Response(JSON.stringify({ code: 1101, message: "积分不足" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call in this test: ${method} ${url} (a real switch must not happen)`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // durationSec: 5 stays on Kling's 5s tier (<=5), 720p (no native audio requested),
    // no audio surcharge → priceCny = table.video["5"] = 2.
    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "静止的湖面",
        durationSec: 5,
        aspectRatio: "16:9",
        generateAudio: false,
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("kling");
    expect(job.durationSec).toBe(5);
    expect(job.priceCny).toBe(2);

    // The refused submit falls back to backoffRequeue (15/30/60s exponential backoff) instead
    // of switching: wait for that requeue to land rather than for a terminal status, since the
    // real failure only arrives after 3 real-time backoff waits (105s) — far more than this
    // suite should spend on one assertion.
    const requeued = await waitUntil(job.id, (rec) => (rec.upstreamRetries ?? 0) >= 1);
    expect(requeued.provider).toBe("kling"); // never switched to yman
    expect(requeued.model).not.toBe("SD2.0 满血");
    expect(requeued.durationSec).toBe(5); // never renormalized to yman's 10s tier
    expect(requeued.priceCny).toBe(2); // never touched
    expect(requeued.status).toBe("queued");
    expect(requeued.nextAttemptAt).toBeTruthy();

    // Kling is still marked exhausted even though the job stayed put — that bookkeeping
    // happens unconditionally, before the duration/price guard is evaluated.
    expect(isExhausted("kling", "video")).toBe(true);
    expect(klingCalls).toBe(1);

    // Defensive: cancel now so the real-time backoff timer this scheduled (~15s out, unref'd)
    // finds nothing to do once it fires, rather than resubmitting to Kling after this test's
    // `afterEach` has already torn down the fetch stub.
    await updateJob(job.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "test cleanup" };
      return r;
    });
  });
});

describe("video failover — refuses to switch to mock", () => {
  it("leaves a Kling-only instance on Kling instead of shipping a watermarked mock clip", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    // No XAI/YMan key: once Kling is exhausted, currentProviderId's only remaining hop is mock.
    const id = owner("f3");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("klingai.com")) {
        return new Response(JSON.stringify({ code: 1102, message: "资源包已用尽" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call in this test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "空镜头",
        durationSec: 5,
        aspectRatio: "16:9",
        generateAudio: false,
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("kling");
    const originalPrice = job.priceCny;

    const requeued = await waitUntil(job.id, (rec) => (rec.upstreamRetries ?? 0) >= 1);
    expect(requeued.provider).toBe("kling");
    expect(requeued.priceCny).toBe(originalPrice);
    expect(requeued.status).toBe("queued");

    await updateJob(job.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "test cleanup" };
      return r;
    });
  });
});

describe("image failover — switches provider on 402, priceCny stays put", () => {
  it("moves a text_to_image job from OpenAI to YMan on a 402 and keeps the original ¥0.5 price", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.IMAGE_PROVIDER_ORDER = "openai,yman";
    process.env.OPENAI_API_KEY = "sk-openai-failover";
    process.env.YMAN_API_KEY = "yman-test-key";
    const id = owner("f4");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your quota" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("yman.cc")) {
        return new Response(
          JSON.stringify({ data: [{ b64_json: await pngBody(1024, 1024) }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected upstream call in this test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(
      {
        mode: "text_to_image",
        prompt: "雨后的城市天际线",
        aspectRatio: "1:1",
        imageResolution: "1k",
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("openai");
    expect(job.priceCny).toBe(0.5); // DEFAULT_PRICE_TABLE.image["1k"]

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("succeeded");
    expect(settled.provider).toBe("yman");
    expect(settled.model).toBe("gpt-image-2"); // default YMAN_IMAGE_MODEL
    // Image failover never renormalizes duration/resolution/audio, so the price is untouched —
    // not just coincidentally equal, but structurally the same computation as before the switch.
    expect(settled.priceCny).toBe(0.5);

    expect(isExhausted("openai", "image")).toBe(true);
    expect(isExhausted("yman", "image")).toBe(false);
  });
});
