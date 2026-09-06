import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderGenerateRequest } from "@/lib/providers/types";

const API_KEY = "sk-openai-secret-do-not-leak";
const jobId = "job_openai_native";

let dataRoot = "";
let openaiImageProvider: (typeof import("./native"))["openaiImageProvider"];

async function pngBuffer(width = 1536, height = 1024): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .png()
    .toBuffer();
}

async function pngBody(width = 1536, height = 1024): Promise<string> {
  return (await pngBuffer(width, height)).toString("base64");
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function imageResponse(bytes: Buffer, mime = "image/png", status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { "content-type": mime } });
}

const TASK_ID = "imgtask_cc90a11dfeed4e83b208d03c45d3d3a3";

/** The 202 envelope the upstream answers a slow generation with. */
function accepted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    error: { message: "图片仍在生成中…", type: "image_task_pending" },
    expires_at: "2026-09-06T00:00:00Z",
    id: TASK_ID,
    poll_after_ms: 2000,
    status: "running",
    ...over,
  };
}

function succeededStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    status: "succeeded",
    result_available: true,
    result_url: `/v1/images/tasks/${TASK_ID}/result`,
    result_content_type: "image/png",
    charged: false,
    charge_status: "pending_delivery",
    estimated_charge: 0.2,
    pricing_currency: "CNY",
    image_quality: "high",
    image_size: "2K",
    duration_ms: 102_000,
    output_format: "png",
    ...over,
  };
}

type FetchCall = { url: string; init: RequestInit };

/**
 * Fake upstream speaking the async protocol: the POST is accepted with 202, each status GET
 * takes the next scripted snapshot (the last one repeats), and `/result` hands back bytes.
 */
function asyncTaskFetch(config: {
  accept?: Record<string, unknown>;
  statuses: Array<Record<string, unknown>>;
  result?: () => Response;
}) {
  const statuses = [...config.statuses];
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if ((init.method ?? "GET") === "POST") return jsonResponse(config.accept ?? accepted(), 202);
    if (url.endsWith("/result")) {
      return config.result ? config.result() : imageResponse(await pngBuffer(1024, 1024));
    }
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    return jsonResponse(next, 200);
  });
  return {
    mock,
    calls,
    posts: () => calls.filter((c) => (c.init.method ?? "GET") === "POST"),
    statusGets: () => calls.filter((c) => !c.url.endsWith("/result") && c.init.method === "GET"),
    resultGets: () => calls.filter((c) => c.url.endsWith("/result")),
  };
}

function req(over: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    jobId,
    mode: "text_to_image",
    model: "gpt-image-1",
    prompt: "一座黄昏里的灯塔",
    generateAudio: false,
    ...over,
  };
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-openai-native-"));
  process.env.DATA_DIR = dataRoot;
  process.env.OPENAI_API_KEY = API_KEY;
  process.env.UPSTREAM_RETRY_BASE_MS = "1";
  ({ openaiImageProvider } = await import("./native"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_IMAGE_TASK_TIMEOUT_MS;
  await rm(path.join(dataRoot, "jobs", jobId), { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.UPSTREAM_RETRY_BASE_MS;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("openaiImageProvider.submit", () => {
  it("stages the image on disk and returns a local path, never a data URI", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        data: [{ b64_json: await pngBody() }],
        usage: { input_tokens: 30, output_tokens: 1056, total_tokens: 1086 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handle = await openaiImageProvider.submit(req({ aspectRatio: "16:9" }));

    expect(handle.providerId).toBe("openai");
    expect(handle.localVideoPath).toBe("tmp/image.jpg");
    expect(handle.remoteUrl).toBeUndefined();
    expect(JSON.stringify(handle)).not.toContain("base64");

    const staged = await readFile(path.join(dataRoot, "jobs", jobId, "tmp/image.jpg"));
    expect([staged[0], staged[1], staged[2]]).toEqual([0xff, 0xd8, 0xff]);
    const meta = await sharp(staged).metadata();
    expect([meta.width, meta.height]).toEqual([1536, 864]);
  });

  it("posts to the official images endpoint with a bearer token", async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: [{ b64_json: await pngBody(1024, 1024) }] }));
    vi.stubGlobal("fetch", fetchMock);

    await openaiImageProvider.submit(req({ aspectRatio: "1:1", imageResolution: "2k" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-image-1",
      prompt: "一座黄昏里的灯塔",
      size: "1024x1024",
      quality: "high",
      n: 1,
      output_format: "png",
    });
  });

  it("prices the call from the reported output tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          data: [{ b64_json: await pngBody(1024, 1024) }],
          usage: { input_tokens: 21, output_tokens: 4160, total_tokens: 4181 },
        }),
      ),
    );

    const handle = await openaiImageProvider.submit(req({ aspectRatio: "1:1", imageResolution: "2k" }));
    // 4160 output tokens × $40 / M
    expect(handle.costUsdActual).toBeCloseTo(0.1664, 6);
  });

  it("falls back to the list price when the response carries no usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ data: [{ b64_json: await pngBody(1024, 1024) }] })));

    const handle = await openaiImageProvider.submit(req({ aspectRatio: "1:1", imageResolution: "1k" }));
    expect(handle.costUsdActual).toBe(0.011);
  });

  it("rejects any mode other than text_to_image before spending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openaiImageProvider.submit(req({ mode: "text_to_video", durationSec: 8 })),
    ).rejects.toMatchObject({ status: 400, code: "unsupported_mode" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an upstream 4xx to a ProviderHttpError without echoing the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "content_policy_violation", message: "Your request was rejected" },
          }),
          { status: 400 },
        ),
      ),
    );

    let thrown: unknown;
    try {
      await openaiImageProvider.submit(req());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "ProviderHttpError",
      status: 400,
      code: "content_policy_violation",
    });
    const serialized = `${(thrown as Error).message} ${(thrown as Error).stack ?? ""}`;
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("sk-openai");
  });

  it("does not retry a 4xx at the business layer (an image may already be billed)", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "invalid_request_error" } }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(openaiImageProvider.submit(req())).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours OPENAI_BASE_URL and appends /v1", async () => {
    process.env.OPENAI_BASE_URL = "https://gw.example.com";
    const fetchMock = vi.fn(async () => okResponse({ data: [{ b64_json: await pngBody(1024, 1024) }] }));
    vi.stubGlobal("fetch", fetchMock);

    await openaiImageProvider.submit(req({ aspectRatio: "1:1" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gw.example.com/v1/images/generations",
      expect.objectContaining({ method: "POST" }),
    );
    delete process.env.OPENAI_BASE_URL;
  });
});

/**
 * The upstream answers one `POST /images/generations` in three shapes; these cover the two the
 * original synchronous parser could not read. Every clock here is fake — the real protocol
 * sleeps seconds between polls and minutes in total.
 */
describe("openaiImageProvider.submit — 200 + raw image bytes", () => {
  it("accepts an image/* body instead of a JSON envelope", async () => {
    const png = await pngBuffer(1024, 1024);
    const fetchMock = vi.fn(async () => imageResponse(png));
    vi.stubGlobal("fetch", fetchMock);

    const handle = await openaiImageProvider.submit(req({ aspectRatio: "1:1" }));

    expect(handle.localVideoPath).toBe("tmp/image.jpg");
    const staged = await readFile(path.join(dataRoot, "jobs", jobId, "tmp/image.jpg"));
    expect([staged[0], staged[1], staged[2]]).toEqual([0xff, 0xd8, 0xff]);
    const meta = await sharp(staged).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1024]);
    // No usage comes with raw bytes, so pricing falls back to the list price for the tier.
    expect(handle.costUsdActual).toBe(0.011);
  });

  it("reads a jpeg body too, and still crops to the requested aspect", async () => {
    const jpg = await sharp(await pngBuffer(1536, 1024)).jpeg().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(jpg, "image/jpeg")));

    await openaiImageProvider.submit(req({ aspectRatio: "16:9" }));

    const meta = await sharp(
      await readFile(path.join(dataRoot, "jobs", jobId, "tmp/image.jpg")),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([1536, 864]);
  });

  it("fails loudly on an empty image body instead of staging a broken file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(Buffer.alloc(0))));

    await expect(openaiImageProvider.submit(req())).rejects.toMatchObject({
      status: 502,
      code: "upstream_invalid_response",
    });
  });
});

describe("openaiImageProvider.submit — 202 async image task", () => {
  it("polls until the task succeeds, fetches the result and sends exactly one POST", async () => {
    const resultPng = await pngBuffer(1024, 1024);
    const upstream = asyncTaskFetch({
      statuses: [
        { id: TASK_ID, status: "running", poll_after_ms: 2000 },
        { id: TASK_ID, status: "running", poll_after_ms: 2000 },
        succeededStatus(),
      ],
      result: () => imageResponse(resultPng),
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const handle = await pending;

    expect(handle.localVideoPath).toBe("tmp/image.jpg");
    const staged = await readFile(path.join(dataRoot, "jobs", jobId, "tmp/image.jpg"));
    expect([staged[0], staged[1], staged[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect((await sharp(staged).metadata()).width).toBe(1024);

    // The billed generation call happens once and only once; everything else is a free GET.
    expect(upstream.posts()).toHaveLength(1);
    expect(upstream.posts()[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(upstream.statusGets()).toHaveLength(3);
    expect(upstream.resultGets()).toHaveLength(1);
    for (const call of [...upstream.statusGets(), ...upstream.resultGets()]) {
      expect(call.init.method).toBe("GET");
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    }
    expect(upstream.statusGets()[0]!.url).toBe(
      `https://api.openai.com/v1/images/tasks/${TASK_ID}`,
    );
  });

  it("waits poll_after_ms between polls", async () => {
    const upstream = asyncTaskFetch({
      accept: accepted({ poll_after_ms: 5000 }),
      statuses: [succeededStatus()],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1" }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(upstream.statusGets()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(upstream.statusGets()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
  });

  it("clamps an absurd poll_after_ms into a sane window", async () => {
    const upstream = asyncTaskFetch({
      accept: accepted({ poll_after_ms: 1 }),
      statuses: [succeededStatus()],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1" }));
    await vi.advanceTimersByTimeAsync(999);
    expect(upstream.statusGets()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
  });

  it("resolves an upstream-relative result_url without doubling the /v1 prefix", async () => {
    process.env.OPENAI_BASE_URL = "https://ccgoai.club/v1";
    const upstream = asyncTaskFetch({
      statuses: [succeededStatus({ result_url: `/v1/images/tasks/${TASK_ID}/result` })],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1" }));
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    const resultUrl = upstream.resultGets()[0]!.url;
    expect(resultUrl).toBe(`https://ccgoai.club/v1/images/tasks/${TASK_ID}/result`);
    expect(resultUrl).not.toContain("/v1/v1/");
    for (const call of upstream.calls) expect(call.url).not.toContain("/v1/v1/");
  });

  it("adds the base path back when result_url omits it", async () => {
    process.env.OPENAI_BASE_URL = "https://ccgoai.club/v1";
    const upstream = asyncTaskFetch({
      statuses: [succeededStatus({ result_url: `/images/tasks/${TASK_ID}/result` })],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1" }));
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(upstream.resultGets()[0]!.url).toBe(
      `https://ccgoai.club/v1/images/tasks/${TASK_ID}/result`,
    );
  });

  it("prefers the upstream's actual_charge once a price table pins the currency", async () => {
    process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({
      high: { "1K": 0.2, "2K": 0.2, "4K": 0.23 },
    });
    const upstream = asyncTaskFetch({
      statuses: [succeededStatus({ actual_charge: 0.17, charged: true, charge_status: "charged" })],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1", imageResolution: "2k" }));
    await vi.advanceTimersByTimeAsync(60_000);
    // 0.17 is the upstream's settled figure; 0.2 would be this tier's table price.
    expect((await pending).costUsdActual).toBe(0.17);
  });

  it("ignores actual_charge without a price table — it is the upstream's currency, not USD", async () => {
    delete process.env.OPENAI_IMAGE_PRICE_TABLE;
    const upstream = asyncTaskFetch({
      statuses: [succeededStatus({ actual_charge: 0.2, charged: true, charge_status: "charged" })],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1", imageResolution: "2k" }));
    await vi.advanceTimersByTimeAsync(60_000);
    // Falls back to the USD list price rather than booking a CNY number into a USD field.
    expect((await pending).costUsdActual).toBe(0.167);
  });

  it("keeps the tier estimate when the task reports no settled charge", async () => {
    const upstream = asyncTaskFetch({
      statuses: [succeededStatus({ actual_charge: 0 })],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1", imageResolution: "1k" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).costUsdActual).toBe(0.011);
  });

  it("surfaces the upstream message when the task ends in a failure state", async () => {
    for (const status of ["failed", "canceled", "expired"]) {
      const upstream = asyncTaskFetch({
        statuses: [{ id: TASK_ID, status, error: { message: "内容审核未通过", type: "content_policy" } }],
      });
      vi.stubGlobal("fetch", upstream.mock);
      vi.useFakeTimers();

      const settled = openaiImageProvider
        .submit(req({ aspectRatio: "1:1" }))
        .then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);

      const thrown = await settled;
      expect(thrown).toMatchObject({ name: "ProviderHttpError", status: 502, code: "content_policy" });
      expect((thrown as Error).message).toContain("内容审核未通过");
      expect((thrown as Error).message).toContain(status);
      // A dead task is never retried into a second billable generation.
      expect(upstream.posts()).toHaveLength(1);
      expect(upstream.resultGets()).toHaveLength(0);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("gives up with image_task_timeout, naming the id that is still queryable", async () => {
    process.env.OPENAI_IMAGE_TASK_TIMEOUT_MS = "8000";
    const upstream = asyncTaskFetch({
      statuses: [{ id: TASK_ID, status: "running", poll_after_ms: 2000 }],
    });
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const settled = openaiImageProvider
      .submit(req({ aspectRatio: "1:1" }))
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);

    const thrown = await settled;
    expect(thrown).toMatchObject({ status: 504, code: "image_task_timeout" });
    expect((thrown as Error).message).toContain(TASK_ID);
    expect((thrown as Error).message).toContain("OPENAI_IMAGE_TASK_TIMEOUT_MS");
    // Bounded: it stopped polling instead of looping forever, and never re-sent the POST.
    expect(upstream.posts()).toHaveLength(1);
    expect(upstream.statusGets().length).toBeLessThanOrEqual(4);
    expect(upstream.resultGets()).toHaveLength(0);
  });

  /**
   * Finding 2: `submit` can block for the whole `OPENAI_IMAGE_TASK_TIMEOUT_MS`, and the
   * runner only checks cancellation on either side of it. Without `shouldAbort`, cancelling
   * a job kept polling and still fetched the result — the one call the upstream bills, since
   * it settles on delivery (`charge_status: "pending_delivery"`). Cancelling used to cost money.
   */
  it("stops between polls once the job is canceled, before even the free status GET", async () => {
    const upstream = asyncTaskFetch({
      statuses: [
        { id: TASK_ID, status: "running", poll_after_ms: 2000 },
        { id: TASK_ID, status: "running", poll_after_ms: 2000 },
        succeededStatus(),
      ],
    });
    // Canceled while the third nap is under way, i.e. after two polls.
    const shouldAbort = vi.fn(async () => upstream.statusGets().length >= 2);
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const settled = openaiImageProvider
      .submit(req({ aspectRatio: "1:1", shouldAbort }))
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await settled).toMatchObject({ status: 499, code: "canceled" });
    expect(upstream.posts()).toHaveLength(1);
    expect(upstream.statusGets()).toHaveLength(2);
    expect(upstream.resultGets()).toHaveLength(0);
    // Nothing was staged, so the runner has no half-finished artifact to commit.
    await expect(
      readFile(path.join(dataRoot, "jobs", jobId, "tmp/image.jpg")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses the billed result fetch even when the image is already waiting upstream", async () => {
    const upstream = asyncTaskFetch({ statuses: [succeededStatus()] });
    // False for the first gate (between polls), true by the time the task reports success —
    // so the only gate that can stop this run is the one guarding the result fetch.
    const shouldAbort = vi.fn(async () => upstream.statusGets().length >= 1);
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const settled = openaiImageProvider
      .submit(req({ aspectRatio: "1:1", shouldAbort }))
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);

    const thrown = await settled;
    expect(thrown).toMatchObject({ status: 499, code: "canceled" });
    expect((thrown as Error).message).toContain(TASK_ID);
    expect(upstream.statusGets()).toHaveLength(1);
    expect(upstream.resultGets()).toHaveLength(0);
  });

  it("is unchanged when shouldAbort never fires", async () => {
    const resultPng = await pngBuffer(1024, 1024);
    const upstream = asyncTaskFetch({
      statuses: [{ id: TASK_ID, status: "running", poll_after_ms: 2000 }, succeededStatus()],
      result: () => imageResponse(resultPng),
    });
    const shouldAbort = vi.fn(async () => false);
    vi.stubGlobal("fetch", upstream.mock);
    vi.useFakeTimers();

    const pending = openaiImageProvider.submit(req({ aspectRatio: "1:1", shouldAbort }));
    await vi.advanceTimersByTimeAsync(60_000);
    const handle = await pending;

    expect(handle.localVideoPath).toBe("tmp/image.jpg");
    expect(upstream.posts()).toHaveLength(1);
    expect(upstream.statusGets()).toHaveLength(2);
    expect(upstream.resultGets()).toHaveLength(1);
    expect(shouldAbort).toHaveBeenCalled();
  });

  it("never consults shouldAbort on the synchronous path, which is already paid for", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ data: [{ b64_json: await pngBody(1024, 1024) }] })));
    // Even an always-true predicate must not throw away an image we have already been billed for.
    const shouldAbort = vi.fn(async () => true);

    const handle = await openaiImageProvider.submit(req({ aspectRatio: "1:1", shouldAbort }));

    expect(handle.localVideoPath).toBe("tmp/image.jpg");
    expect(shouldAbort).not.toHaveBeenCalled();
  });

  it("fails clearly when a 202 carries no task id to poll", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "running", poll_after_ms: 2000 }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(openaiImageProvider.submit(req())).rejects.toMatchObject({
      status: 502,
      code: "upstream_invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("openaiImageProvider.poll", () => {
  it("reports done without calling upstream (images are synchronous)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(openaiImageProvider.poll({ providerId: "openai", remoteId: jobId })).resolves.toEqual({
      status: "done",
      progress: 100,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
