import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "@/lib/providers/types";
import type { JobRecord } from "./schema";

// Harness jobs never call provider.submit directly — the orchestrator owns the upstream
// calls — so the failover test below drives `switchAwayFromExhausted` by making the
// orchestrator itself throw the same ProviderHttpError a quota_exhausted submit would.
vi.mock("@/lib/harness/orchestrator", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/harness/orchestrator")>();
  return {
    ...mod,
    harnessOrchestrator: {
      execute: async () => {
        throw new ProviderHttpError(429, "quota_exhausted", "stub: upstream out of credit");
      },
    },
  };
});

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
let resetHealth: typeof import("@/lib/providers/health").__resetHealthForTests;

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
  ({ __resetHealthForTests: resetHealth } = await import("@/lib/providers/health"));
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
  delete process.env.HARNESS_ENABLED;
  delete process.env.RELAY_MAX_SWITCHES;
  process.env.LUMEN_FORCE_MOCK = "1";
  // Health state is a top-level file next to `jobs/` plus an in-memory map, independent of
  // any one job — reset both between tests so one test's markExhausted cannot change which
  // provider the *next* test's createJob starts on.
  resetHealth();
  await rm(path.join(dataRoot, "provider-health.json"), { force: true });
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
    expect(switched.model).toBe("minimax-h3"); // yman/catalog.ts display name for the t2v model
    // YMan's only resolution is 720p and providerSettingsFor forces yman audio to "off" (its
    // create-task API has no audio switch) — so the recalculated price is table.video["10"]=4,
    // no hd multiplier, no audio surcharge. min(7, 4) = 4.
    expect(switched.durationSec).toBe(10);
    expect(switched.resolution).toBe("720p");
    expect(switched.generateAudio).toBe(false);
    expect(switched.priceCny).toBe(4);
    // 换家留痕落盘：从哪来 / 到哪去 / 被哪个错误码赶走。
    expect(switched.providerSwitches).toEqual([
      { from: "kling", to: "yman", code: "quota_exhausted", at: expect.any(String) },
    ]);

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

describe("video failover — harness keeps its 30s target when switching provider", () => {
  it("moves a 30s harness job from Kling to YMan: duration stays 30, resolution renormalizes", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.HARNESS_ENABLED = "true";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    const id = owner("f9");
    await seedBalance(id, 1000);

    const { job } = await createJob(
      { mode: "text_to_video", prompt: "长镜头连拍", durationSec: 30, generateAudio: false } as Parameters<
        typeof createJob
      >[0],
      id,
    );
    expect(job.provider).toBe("kling");
    expect(job.durationSec).toBe(30);

    // The mocked orchestrator throws quota_exhausted; the job must switch to YMan while
    // keeping the harness target duration — never normalized to a 10s clip.
    const switched = await waitUntil(job.id, (rec) => rec.provider === "yman");
    expect(switched.durationSec).toBe(30);
    expect(switched.harness?.enabled).toBe(true);
    expect(switched.resolution).toBe("720p"); // YMan only serves 720p

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("failed"); // every ORDER member exhausts in turn
    expect(isExhausted("kling", "video")).toBe(true);
  });
});

describe("certain-rejection failover — explicit product never switches (N3.4)", () => {
  it("fails a user-picked product with product_unavailable instead of delivering another provider", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling,yman";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.YMAN_API_KEY = "yman-test-key";
    const id = owner("f10");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("klingai.com")) {
        return new Response(JSON.stringify({ code: 1101, message: "积分不足" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call in this test: ${url} (a picked product must not roam)`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // `model` = 产品 id（video-standard 是 kling 的产品）：用户点名了它，换成 YMan
    // 交付的是他没选的产品——确定拒绝只能失败退款，不能换家。
    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "点名的模型",
        durationSec: 5,
        aspectRatio: "16:9",
        generateAudio: false,
        model: "video-standard",
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("kling");
    expect(job.product).toBe("video-standard");

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("failed");
    expect(settled.error?.code).toBe("product_unavailable");
    expect(settled.provider).toBe("kling");
    expect(settled.providerSwitches).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("yman.cc"))).toHaveLength(0);
  });
});

describe("certain-rejection failover — rate_limited cools down via Retry-After then switches", () => {
  it("moves off YMan on a 429 + Retry-After and lands on Kling, both recorded", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    const id = owner("f11");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("yman.cc")) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "120" },
        });
      }
      if (url.includes("klingai.com")) {
        return new Response(JSON.stringify({ code: 1101, message: "积分不足" }), {
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
        prompt: "限流换家",
        durationSec: 5,
        aspectRatio: "16:9",
        generateAudio: false,
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("yman");

    const switched = await waitUntil(job.id, (rec) => rec.provider === "kling");
    expect(switched.providerSwitches).toEqual([
      { from: "yman", to: "kling", code: "rate_limited", at: expect.any(String) },
    ]);
    // Retry-After: 120s 的冷却立刻生效，路由与产品目录都绕开 YMan。
    expect(isExhausted("yman", "video")).toBe(true);

    // Kling 也以确定拒绝收场：试过 yman+kling 后没有下一家 → 回退避路径。
    const requeued = await waitUntil(job.id, (rec) => (rec.upstreamRetries ?? 0) >= 1);
    expect(requeued.provider).toBe("kling");
    expect(requeued.providerSwitches).toHaveLength(1); // 次数按任务计，不因 kling 再拒绝而重复换
    expect(isExhausted("kling", "video")).toBe(true);

    await updateJob(job.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "test cleanup" };
      return r;
    });
  });
});

describe("certain-rejection failover — RELAY_MAX_SWITCHES caps hops per job", () => {
  it("RELAY_MAX_SWITCHES=0 keeps the job on the rejected provider and backs off", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.RELAY_MAX_SWITCHES = "0";
    const id = owner("f12");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("yman.cc")) {
        return new Response(JSON.stringify({ error: { message: "out of credit" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call in this test: ${url} (switch budget is 0)`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "预算为零不换家",
        durationSec: 5,
        aspectRatio: "16:9",
        generateAudio: false,
      } as Parameters<typeof createJob>[0],
      id,
    );
    expect(job.provider).toBe("yman");

    const requeued = await waitUntil(job.id, (rec) => (rec.upstreamRetries ?? 0) >= 1);
    expect(requeued.provider).toBe("yman");
    expect(requeued.providerSwitches).toBeUndefined();
    // 不换家 ≠ 不记账：402 的 quota_exhausted 冷却照常落。
    expect(isExhausted("yman", "video")).toBe(true);

    await updateJob(job.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "test cleanup" };
      return r;
    });
    delete process.env.RELAY_MAX_SWITCHES;
  });

  it("two certain rejections chain yman→kling→grok, then the third stays put", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "yman,kling,grok";
    process.env.YMAN_API_KEY = "yman-test-key";
    process.env.KLING_API_KEY = "kling-test-key";
    process.env.XAI_API_KEY = "xai-test-key";
    const id = owner("f13");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("yman.cc")) {
        return new Response(JSON.stringify({ error: { message: "out of credit" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("klingai.com")) {
        return new Response(JSON.stringify({ code: 1101, message: "积分不足" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.x.ai")) {
        return new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected upstream call in this test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(
      {
        mode: "text_to_video",
        prompt: "三连拒",
        durationSec: 5,
        aspectRatio: "16:9",
        generateAudio: false,
      } as Parameters<typeof createJob>[0],
      id,
    );

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("failed");
    expect(settled.provider).toBe("grok"); // 换家名额 2 用完后停在 grok
    expect(settled.providerSwitches).toEqual([
      { from: "yman", to: "kling", code: "quota_exhausted", at: expect.any(String) },
      { from: "kling", to: "grok", code: "quota_exhausted", at: expect.any(String) },
    ]);
    // 每家被拒都记了健康：yman / kling 是 quota 6h，grok 的 401 只进窗口样本。
    expect(isExhausted("yman", "video")).toBe(true);
    expect(isExhausted("kling", "video")).toBe(true);
  });
});
