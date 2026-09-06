import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { klingProvider } from "./native";
import type { ProviderGenerateRequest, ProviderHandle } from "@/lib/providers/types";

beforeEach(() => {
  vi.stubEnv("KLING_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function req(over: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    jobId: "job_kling_native",
    mode: "text_to_video",
    prompt: "a river at dawn",
    model: "kling-2.6",
    generateAudio: false,
    aspectRatio: "16:9",
    ...over,
  };
}

describe("klingProvider.capabilities", () => {
  it("only advertises t2v/i2v up to 10s at 1080p", () => {
    expect(klingProvider.id).toBe("kling");
    expect(klingProvider.capabilities()).toEqual({
      modes: ["text_to_video", "image_to_video"],
      maxDurationSec: 10,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    });
  });
});

describe("klingProvider.submit", () => {
  it("posts to the model's t2v endpoint and returns the upstream task id as remoteId", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 0, message: "", request_id: "req_1", data: { id: "kltask_1", status: "submitted" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handle = await klingProvider.submit(req());

    expect(handle).toEqual({ providerId: "kling", remoteId: "kltask_1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api-beijing.klingai.com/text-to-video/kling-2.6");
  });

  it("submits image_to_video against the i2v endpoint with the hydrated first frame", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: { id: "kltask_2", status: "submitted" } }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = await klingProvider.submit(
      req({
        mode: "image_to_video",
        aspectRatio: undefined,
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
      }),
    );

    expect(handle).toEqual({ providerId: "kling", remoteId: "kltask_2" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api-beijing.klingai.com/image-to-video/kling-2.6");
    expect(JSON.parse(String(init.body)).contents).toEqual([
      { type: "prompt", text: "a river at dawn" },
      { type: "first_frame", url: "data:image/jpeg;base64,aaa" },
    ]);
  });

  it("throws when the upstream accepts the task but returns no usable id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, data: {} })));
    await expect(klingProvider.submit(req())).rejects.toThrow(/任务 id/);
  });
});

describe("klingProvider.poll", () => {
  const handle: ProviderHandle = { providerId: "kling", remoteId: "kltask_1" };

  it("reports pending at progress 5 while submitted, querying GET /tasks?task_ids=<remoteId>", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: [{ id: "kltask_1", status: "submitted" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingProvider.poll(handle)).resolves.toMatchObject({ status: "pending", progress: 5 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api-beijing.klingai.com/tasks?task_ids=kltask_1");
  });

  it("reports pending at progress 40 while processing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: 0, data: [{ id: "kltask_1", status: "processing" }] })),
    );
    await expect(klingProvider.poll(handle)).resolves.toMatchObject({ status: "pending", progress: 40 });
  });

  it("reports done with the video url and duration once succeeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: 0,
          data: [
            {
              id: "kltask_1",
              status: "succeeded",
              outputs: [{ type: "video", url: "https://cdn.klingai.com/out.mp4", duration: 5 }],
            },
          ],
        }),
      ),
    );
    await expect(klingProvider.poll(handle)).resolves.toMatchObject({
      status: "done",
      progress: 100,
      remoteUrl: "https://cdn.klingai.com/out.mp4",
      durationSec: 5,
    });
  });

  it("fails as not_found when the upstream returns an empty task list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 0, data: [] })));
    await expect(klingProvider.poll(handle)).resolves.toMatchObject({
      status: "failed",
      errorCode: "not_found",
    });
  });

  it("fails as no_id without calling upstream when the handle carries no remoteId", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(klingProvider.poll({ providerId: "kling" })).resolves.toMatchObject({
      status: "failed",
      errorCode: "no_id",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
