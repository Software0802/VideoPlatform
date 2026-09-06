import { afterEach, describe, expect, it, vi } from "vitest";
import { ymanGet, ymanPost } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("YMan REST client", () => {
  it("ymanPost hits ymanBase()+path with a Bearer token and JSON body, resolving the full response body", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => jsonResponse({ id: "vid_1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await ymanPost("/videos", { model: "minimax_h3_t2v", prompt: "p" });

    expect(data).toEqual({ id: "vid_1", status: "queued" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vip.yman.cc/v1/videos");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({ model: "minimax_h3_t2v", prompt: "p" });
  });

  it("ymanGet hits ymanBase()+path with a Bearer token and no body", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => jsonResponse({ id: "vid_1", status: "in_progress" }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await ymanGet("/videos/vid_1");

    expect(data).toEqual({ id: "vid_1", status: "in_progress" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vip.yman.cc/v1/videos/vid_1");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(init.body).toBeUndefined();
  });

  it("respects a YMAN_BASE_URL override for both verbs", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    vi.stubEnv("YMAN_BASE_URL", "https://relay.example.com/v1");
    const fetchMock = vi.fn(async () => jsonResponse({ id: "vid_1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    await ymanGet("/videos/vid_1");
    await ymanPost("/videos", { model: "m", prompt: "p" });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const urls = calls.map((c) => c[0]);
    expect(urls).toEqual(["https://relay.example.com/v1/videos/vid_1", "https://relay.example.com/v1/videos"]);
  });

  it("does not retry a 429 on ymanPost — a repeated create would start a second billable task", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "并发已满" } }, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ymanPost("/videos", { model: "m", prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 on ymanGet before succeeding", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ id: "vid_1", status: "completed" }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await ymanGet("/videos/vid_1");
    expect(data).toEqual({ id: "vid_1", status: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("HTTP status -> error code mapping (ymanError)", () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_argument"],
      [402, "quota_exhausted"],
      [404, "not_found"],
      [409, "not_ready"],
      [413, "invalid_argument"],
      [429, "rate_limited"],
      [451, "moderation"],
    ];
    for (const [status, code] of cases) {
      it(`maps HTTP ${status} to code "${code}", keeping the original HTTP status`, async () => {
        vi.stubEnv("YMAN_API_KEY", "test-key");
        vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, status)));
        await expect(ymanGet("/videos/x")).rejects.toMatchObject({ status, code });
      });
    }
  });

  it("passes through an unmapped 5xx with the upstream's own error.code when present", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "internal_error", message: "挂了" } }, 500)),
    );

    await expect(ymanGet("/videos/x")).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      message: "挂了",
    });
  });

  it("falls back to upstream_http_<status> when an unmapped status carries no error code", async () => {
    vi.stubEnv("YMAN_API_KEY", "test-key");
    vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));

    await expect(ymanGet("/videos/x")).rejects.toMatchObject({
      status: 500,
      code: "upstream_http_500",
    });
  });

  it("fails fast without calling upstream when YMAN_API_KEY is missing", async () => {
    vi.stubEnv("YMAN_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ymanPost("/videos", { model: "m", prompt: "p" })).rejects.toMatchObject({
      status: 500,
      code: "missing_api_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
