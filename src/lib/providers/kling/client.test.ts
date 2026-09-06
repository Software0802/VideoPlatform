import { afterEach, describe, expect, it, vi } from "vitest";
import { klingGet, klingPost } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Kling REST client", () => {
  it("klingPost hits klingBase()+path with a Bearer token and JSON body, resolving the full envelope", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 0, message: "", request_id: "req_1", data: { id: "task_1", status: "submitted" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const data = await klingPost("/text-to-video/kling-2.6", { prompt: "p" });

    expect(data).toEqual({ code: 0, message: "", request_id: "req_1", data: { id: "task_1", status: "submitted" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api-beijing.klingai.com/text-to-video/kling-2.6");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({ prompt: "p" });
  });

  it("klingGet hits klingBase()+path with a Bearer token and no body", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 0, message: "", request_id: "req_2", data: [{ id: "task_1", status: "processing" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const data = await klingGet("/tasks?task_ids=task_1");

    expect(data).toEqual({
      code: 0,
      message: "",
      request_id: "req_2",
      data: [{ id: "task_1", status: "processing" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api-beijing.klingai.com/tasks?task_ids=task_1");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(init.body).toBeUndefined();
  });

  it("does not retry a 429 on klingPost — a repeated create would start a second billable task", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
    const fetchMock = vi.fn(async () => jsonResponse({ code: 1303, message: "并发超出资源包限制" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingPost("/text-to-video/kling-2.6", { prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 on klingGet before succeeding", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    vi.stubEnv("UPSTREAM_RETRY_BASE_MS", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 5001, message: "服务暂不可用" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, message: "", request_id: "req_3", data: [{ id: "task_1", status: "succeeded" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const data = await klingGet("/tasks?task_ids=task_1");
    expect(data.data).toEqual([{ id: "task_1", status: "succeeded" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an HTTP 200 envelope with an unmapped code!==0 as a 400 (kling_<code>)", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => jsonResponse({ code: 1200, message: "参数错误", request_id: "req_4" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingGet("/tasks?task_ids=bad")).rejects.toMatchObject({
      status: 400,
      code: "kling_1200",
    });
  });

  it("maps the content-safety code 1301 to moderation even though the transport reported 200", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => jsonResponse({ code: 1301, message: "涉及内容安全" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingPost("/text-to-video/kling-2.6", { prompt: "违规词" })).rejects.toMatchObject({
      status: 400,
      code: "moderation",
      message: "涉及内容安全",
    });
  });

  it("keeps an unmapped code's real transport status when it is already non-2xx", async () => {
    vi.stubEnv("KLING_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => jsonResponse({ code: 9999, message: "未知错误" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingGet("/tasks?task_ids=bad")).rejects.toMatchObject({
      status: 500,
      code: "kling_9999",
    });
  });

  it("fails fast without calling upstream when KLING_API_KEY is missing", async () => {
    vi.stubEnv("KLING_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingPost("/text-to-video/kling-2.6", { prompt: "p" })).rejects.toMatchObject({
      status: 500,
      code: "missing_api_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
