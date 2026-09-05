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

async function pngBody(width = 1536, height = 1024): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
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
  vi.unstubAllGlobals();
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
