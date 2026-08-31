import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteXaiFile, grokGet, grokPost } from "./client";

const ENV_KEYS = [
  "SUB2API_API_KEY",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "UPSTREAM_TIMEOUT_MS",
  "UPSTREAM_RETRY_BASE_MS",
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("Grok REST client", () => {
  it("uses the configured local Sub2API base and bearer token", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: "req_local" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const data = await grokPost("/videos/generations", { model: "grok-imagine-video-1.5" });

    expect(data.request_id).toBe("req_local");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/videos/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("preserves an upstream error code and status", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "grok_media_no_eligible_account",
              message: "没有可用的 Grok 媒体账户",
            },
          }),
          { status: 503 },
        ),
      ),
    );

    await expect(grokGet("/videos/req_local")).rejects.toMatchObject({
      status: 503,
      code: "grok_media_no_eligible_account",
      message: "没有可用的 Grok 媒体账户",
    });
  });

  it("retries transient upstream failures before surfacing an error", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.UPSTREAM_RETRY_BASE_MS = "1";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "service_unavailable" } }), { status: 503 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "req_retry" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(grokPost("/videos/generations", { model: "grok-imagine-video" })).resolves.toEqual({
      request_id: "req_retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung upstream request", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.UPSTREAM_TIMEOUT_MS = "5";
    process.env.UPSTREAM_RETRY_BASE_MS = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      ),
    );

    const testTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("test timeout")), 100),
    );
    await expect(Promise.race([grokGet("/videos/never"), testTimeout])).rejects.toMatchObject({
      code: "upstream_timeout",
    });
  });

  it("aborts a hung best-effort file deletion instead of blocking cancellation", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.UPSTREAM_TIMEOUT_MS = "5";
    process.env.UPSTREAM_RETRY_BASE_MS = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      ),
    );

    const testTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("test timeout")), 100),
    );
    await expect(Promise.race([deleteXaiFile("file-hung"), testTimeout])).resolves.toBeUndefined();
  });
});
