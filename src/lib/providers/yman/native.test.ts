import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ymanProvider } from "./native";
import type { ProviderGenerateRequest, ProviderHandle } from "@/lib/providers/types";

beforeEach(() => {
  vi.stubEnv("YMAN_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// `model: ""` on purpose — it forces resolveYmanSettings down its real mode-based default
// (YMAN_T2V_MODEL for t2v, YMAN_I2V_MODEL for i2v/r2v) unless a test overrides it. A fixed
// t2v model default here would silently break an i2v/r2v test: unlike Kling, YMan's model
// resolution depends on req.model first and only falls back to the mode when it's empty.
function req(over: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    jobId: "job_yman_native",
    mode: "text_to_video",
    prompt: "海上日出",
    model: "",
    generateAudio: false,
    aspectRatio: "16:9",
    durationSec: 5,
    ...over,
  };
}

describe("ymanProvider.capabilities", () => {
  // modes 用 arrayContaining 而不是精确相等：YMan 现在也接文生图（另一条独立于本文件
  // 覆盖范围的路径，见 provider-settings.ts 的 ymanImageModel），这里只钉住这个 provider
  // 测试文件负责的三条视频模式，不对 modes 数组的其余内容或长度做断言。
  it("advertises t2v/i2v/r2v and no last-frame lock", () => {
    expect(ymanProvider.id).toBe("yman");
    expect(ymanProvider.capabilities().modes).toEqual(
      expect.arrayContaining(["text_to_video", "image_to_video", "reference_to_video"]),
    );
    // 尾帧只落盘、永不进请求体是全项目硬约束；一个从不接受尾帧的 provider 不该
    // 声明自己支持尾帧锁定。
    expect(ymanProvider.capabilities().supportsLastFrameLock).toBe(false);
  });

  it("advertises the aspect ratios its default t2v/i2v models support, for the router's hard ratio filter", () => {
    // types.ts: "路由拿它当硬条件...让它把画幅悄悄换成自己的第一档——用户选的画幅是需求，不是建议。"
    // Under the default catalog (before any YMAN_T2V_MODEL/YMAN_I2V_MODEL override) neither
    // default model lists 1:1 — see catalog.test.ts's ymanVideoRatios tests for the model
    // that does (SD2.0 满血).
    expect(ymanProvider.capabilities().aspectRatios?.slice().sort()).toEqual(["16:9", "9:16"].sort());
  });
});

describe("ymanProvider.submit", () => {
  it("posts to POST /videos and returns the upstream id as remoteId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "vid_1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = await ymanProvider.submit(req());

    expect(handle).toEqual({ providerId: "yman", remoteId: "vid_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vip.yman.cc/v1/videos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ seconds: "5", size: "1280x720" });
  });

  it("submits image_to_video with the first frame folded into reference_images", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "vid_2", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = await ymanProvider.submit(
      req({
        mode: "image_to_video",
        aspectRatio: undefined,
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
      }),
    );

    expect(handle).toEqual({ providerId: "yman", remoteId: "vid_2" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reference_images).toEqual(["data:image/jpeg;base64,aaa"]);
  });

  it("throws when the upstream accepts the task but returns no usable id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "queued" })));
    await expect(ymanProvider.submit(req())).rejects.toThrow(/任务 id/);
  });
});

describe("ymanProvider.poll", () => {
  const handle: ProviderHandle = { providerId: "yman", remoteId: "vid_1" };

  it("reports pending at progress 5 while queued, querying GET /videos/<remoteId>", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "vid_1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ymanProvider.poll(handle)).resolves.toMatchObject({ status: "pending", progress: 5 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://vip.yman.cc/v1/videos/vid_1");
  });

  it("reports pending at progress 40 while in_progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "vid_1", status: "in_progress" })));
    await expect(ymanProvider.poll(handle)).resolves.toMatchObject({ status: "pending", progress: 40 });
  });

  it("treats a 409 (content not ready yet) as pending progress 40, not a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "还没好" } }, 409)));
    await expect(ymanProvider.poll(handle)).resolves.toEqual({ status: "pending", progress: 40 });
  });

  it("reports done with the /videos/<id>/content URL once completed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "vid_1", status: "completed" })));
    await expect(ymanProvider.poll(handle)).resolves.toMatchObject({
      status: "done",
      progress: 100,
      remoteUrl: "https://vip.yman.cc/v1/videos/vid_1/content",
    });
  });

  /**
   * 与可灵不同：可灵在任务列表里找不到该 id 时把它当作一次已解析的失败结果返回；
   * YMan 直接 GET 单个资源，404 是 client.ts 抛出的 ProviderHttpError，poll() 只特判
   * "not_ready"（409）转成 pending，其余一律原样往外抛——runner 的 pollUntilDone
   * 会捕获非重试性错误并把任务标记失败，最终用户可见的结果相同，但这里是 reject
   * 而不是 resolve。
   */
  it("propagates a 404 (task not found) as a rejection rather than a resolved failed poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "没有这个任务" } }, 404)));
    await expect(ymanProvider.poll(handle)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("fails as no_id without calling upstream when the handle carries no remoteId", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ymanProvider.poll({ providerId: "yman" })).resolves.toMatchObject({
      status: "failed",
      errorCode: "no_id",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
