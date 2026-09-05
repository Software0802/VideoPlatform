import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "./schema";

/**
 * End-to-end for the OpenAI image path: createJob → runner submit → persist.
 *
 * It exists to hold two fixes that unit tests cannot see, because both live in the seam
 * between the provider and the runner:
 *  1. a provider that stages its own file still gets `costUsdActual` booked into job.json
 *     (it used to be written only in the `remoteUrl` branch, so image charges vanished);
 *  2. one billed upstream call stays one call — no transport retry on a paid POST.
 */

const API_KEY = "sk-openai-lifecycle";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let readJob: (id: string) => Promise<JobRecord | null>;

async function pngBody(width: number, height: number): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

/** Poll job.json until the runner leaves the in-flight states. */
async function waitForSettled(id: string, timeoutMs = 20_000): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readJob(id);
    if (rec && ["succeeded", "failed", "canceled", "expired"].includes(rec.status)) return rec;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${id} did not settle in ${timeoutMs}ms`);
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-openai-lifecycle-"));
  process.env.DATA_DIR = dataRoot;
  process.env.OPENAI_API_KEY = API_KEY;
  process.env.UPSTREAM_RETRY_BASE_MS = "1";
  delete process.env.XAI_API_KEY;
  delete process.env.SUB2API_API_KEY;
  delete process.env.LUMEN_FORCE_MOCK;
  ({ createJob } = await import("./create"));
  ({ readJob } = await import("./store"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_IMAGE_FLEXIBLE_SIZES;
  delete process.env.OPENAI_IMAGE_QUALITY;
  delete process.env.OPENAI_IMAGE_PRICE_TABLE;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.UPSTREAM_RETRY_BASE_MS;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("OpenAI image job lifecycle", () => {
  it("books the provider's charge into job.json and crops to the requested aspect", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: await pngBody(1536, 1024) }],
          usage: { input_tokens: 22, output_tokens: 1056, total_tokens: 1078 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob({
      mode: "text_to_image",
      prompt: "黄昏的灯塔",
      aspectRatio: "16:9",
      imageResolution: "1k",
    } as Parameters<typeof createJob>[0]);

    expect(job.provider).toBe("openai");
    expect(job.model).toBe("gpt-image-1");

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("succeeded");

    // 1056 output tokens × $40/M — the usage-based figure, not the list-price fallback.
    expect(settled.costUsdActual).toBeCloseTo(0.04224, 6);

    const imageAbs = path.join(dataRoot, "jobs", job.id, "outputs", "image.jpg");
    expect((await stat(imageAbs)).isFile()).toBe(true);
    const meta = await sharp(await readFile(imageAbs)).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 1536, height: 864 });

    // job.json must stay small: the bytes live on disk, never as a data URI on the record.
    const rawJson = await readFile(path.join(dataRoot, "jobs", job.id, "job.json"), "utf8");
    expect(rawJson).not.toMatch(/b64_json|data:image/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks a flexible upstream for native pixels and books the tiered price end to end", async () => {
    process.env.OPENAI_IMAGE_FLEXIBLE_SIZES = "1";
    process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({
      low: { "1K": 0.08, "2K": 0.08, "4K": 0.1 },
      medium: { "1K": 0.13, "2K": 0.13, "4K": 0.15 },
      high: { "1K": 0.2, "2K": 0.2, "4K": 0.23 },
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: await pngBody(2048, 1152) }],
          size: "2048x1152",
          quality: "high",
          // A relay forwards an OpenAI-shaped usage block, but it bills per tier — the
          // table must win over these tokens.
          usage: { input_tokens: 19, output_tokens: 6208, total_tokens: 6227 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob({
      mode: "text_to_image",
      prompt: "宽幅海岸线",
      aspectRatio: "16:9",
      imageResolution: "2k",
    } as Parameters<typeof createJob>[0]);

    // Booked at submit from the same size/quality the request will carry — never 0.
    expect(job.costUsdEstimate).toBe(0.2);

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("succeeded");
    expect(settled.costUsdActual).toBe(0.2);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.size).toBe("2048x1152");
    expect(body.quality).toBe("high");

    // Native size, so nothing is cropped away.
    const meta = await sharp(
      await readFile(path.join(dataRoot, "jobs", job.id, "outputs", "image.jpg")),
    ).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 2048, height: 1152 });
  });

  it("rides out a 202 async task: polls, fetches the result and books the tiered price", async () => {
    process.env.OPENAI_IMAGE_FLEXIBLE_SIZES = "1";
    process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({
      high: { "1K": 0.2, "2K": 0.2, "4K": 0.23 },
    });
    const taskId = "imgtask_cc90a11dfeed4e83b208d03c45d3d3a3";
    const resultPng = await sharp({
      create: { width: 2048, height: 1152, channels: 3, background: { r: 12, g: 40, b: 90 } },
    })
      .png()
      .toBuffer();

    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? "GET") === "POST") {
        // The slow path in production: high-tier 2K takes ~102s upstream, far past its
        // synchronous window, so the generation call comes back accepted-but-empty.
        return new Response(
          JSON.stringify({
            error: { message: "图片仍在生成中…", type: "image_task_pending" },
            id: taskId,
            // Clamped up to the 1s floor, so the whole test still settles in about a second.
            poll_after_ms: 1,
            status: "running",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/result")) {
        return new Response(new Uint8Array(resultPng), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(
        JSON.stringify({
          id: taskId,
          status: "succeeded",
          result_available: true,
          result_url: `/v1/images/tasks/${taskId}/result`,
          result_content_type: "image/png",
          // Nothing is billed until the result is fetched, so the finished task still reports
          // no settled charge — the tier table has to price this job.
          charged: false,
          charge_status: "pending_delivery",
          actual_charge: 0,
          estimated_charge: 0.2,
          pricing_currency: "CNY",
          image_quality: "high",
          image_size: "2K",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob({
      mode: "text_to_image",
      prompt: "慢工出的宽幅海岸线",
      aspectRatio: "16:9",
      imageResolution: "2k",
    } as Parameters<typeof createJob>[0]);

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("succeeded");
    expect(settled.costUsdActual).toBe(0.2);

    const meta = await sharp(
      await readFile(path.join(dataRoot, "jobs", job.id, "outputs", "image.jpg")),
    ).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 2048, height: 1152 });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    // One billed generation POST; the polls and the result fetch are free GETs.
    expect(calls.filter(([, init]) => (init.method ?? "GET") === "POST")).toHaveLength(1);
    expect(calls.filter(([url]) => url.endsWith("/result"))).toHaveLength(1);
    expect(calls.filter(([url]) => url.includes("/images/tasks/") && !url.endsWith("/result"))).toHaveLength(1);
    for (const [url] of calls) expect(url).not.toContain("/v1/v1/");

    const rawJson = await readFile(path.join(dataRoot, "jobs", job.id, "job.json"), "utf8");
    expect(rawJson).not.toMatch(/b64_json|data:image/);
  });

  it("does not retry a billed POST when the upstream returns a retryable status", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob({
      mode: "text_to_image",
      prompt: "重复计费守卫",
      aspectRatio: "1:1",
    } as Parameters<typeof createJob>[0]);

    const settled = await waitForSettled(job.id);
    expect(settled.status).toBe("failed");
    // 503 is in RETRYABLE_STATUS; the generic transport would have sent it 3 times.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
