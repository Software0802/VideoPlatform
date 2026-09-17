import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteXaiFile, grokGet, grokPost } from "./client";

const ENV_KEYS = [
  "SUB2API_API_KEY",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "UPSTREAM_TIMEOUT_MS",
  "UPSTREAM_RETRY_BASE_MS",
  "UPSTREAM_BODY_IDLE_MS",
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

describe("响应体的静默看门狗", () => {
  /*
    真实事故形状（2026-09-17）：上游把响应头发过来、然后不再发数据也不断开。
    `UPSTREAM_TIMEOUT_MS` 那只定时器在响应头到达时就被清掉了，此后读响应体没有任何时限，
    于是成片下载永远停在 `pipeline()`、任务永远停在 `persisting`——界面上的画布节点 /
    任务卡一直转圈，刷新也没用，因为服务端记录本来就没到终态。
  */

  /** 一个「发了头、然后装死」的响应；只有 abort 能把它叫醒（与 undici 的行为一致）。 */
  function stalledFetch(firstChunk?: string) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (firstChunk) controller.enqueue(new TextEncoder().encode(firstChunk));
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          });
          // 之后既不 enqueue 也不 close：这就是「卡住」。
        },
      });
      return new Response(body, { status: 200 });
    });
  }

  it("读到一半不再来数据 → 按静默上限放弃，而不是永远挂着", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.UPSTREAM_BODY_IDLE_MS = "60";
    vi.stubGlobal("fetch", stalledFetch('{"partial":'));

    const { fetchUpstream } = await import("./client");
    const res = await fetchUpstream("http://127.0.0.1:8080/v1/files/f1/content", {});
    // 头已经到了——原来的超时到此为止，问题全在下面这一步。
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  }, 10_000);

  it("一个字节都不来时，轮询调用会在静默上限内返回而不是永远挂着", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.UPSTREAM_BODY_IDLE_MS = "60";
    vi.stubGlobal("fetch", stalledFetch());

    // `grokGet` 对读体失败是 `.catch(() => ({}))`——空对象等于「这拍没读到状态」，
    // 轮询下一拍再来，`pollUntilDone` 的总时限也才有机会生效。要点是它**返回了**：
    // 修复前这一行会永远停在这里，任务于是永远停在 pending / persisting。
    const started = Date.now();
    await expect(grokGet("/videos/xyz")).resolves.toEqual({});
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("一直在传的慢响应不受影响（每次数据都续上看门狗）", async () => {
    process.env.SUB2API_API_KEY = "sk-test";
    process.env.XAI_BASE_URL = "http://127.0.0.1:8080/v1";
    process.env.UPSTREAM_BODY_IDLE_MS = "120";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const parts = ['{"status"', ':"succeeded"', "}"];
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const part of parts) {
              await new Promise((r) => setTimeout(r, 60));
              controller.enqueue(new TextEncoder().encode(part));
            }
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    await expect(grokGet("/videos/xyz")).resolves.toMatchObject({ status: "succeeded" });
  }, 10_000);
});
