import { afterEach, describe, expect, it, vi } from "vitest";
import { mapKlingTask, mapToKlingRequest, normalizeKlingDuration, resolveKlingSettings } from "./rest-map";
import type { ProviderGenerateRequest } from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

afterEach(() => {
  vi.unstubAllEnvs();
});

function base(over: Partial<ProviderGenerateRequest>): ProviderGenerateRequest {
  return {
    jobId: "job_test",
    mode: "text_to_video",
    prompt: "rain on the bund",
    model: "kling-2.6",
    generateAudio: false,
    ...over,
  };
}

/** Captures a single synchronous throw so status/code can be inspected without calling twice. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("normalizeKlingDuration", () => {
  it("buckets to 5 at or below 5s, 10 above, and defaults undefined to 5", () => {
    expect(normalizeKlingDuration(4)).toBe(5);
    expect(normalizeKlingDuration(5)).toBe(5);
    expect(normalizeKlingDuration(6)).toBe(10);
    expect(normalizeKlingDuration(10)).toBe(10);
    expect(normalizeKlingDuration(undefined)).toBe(5);
  });
});

describe("resolveKlingSettings", () => {
  it("uses the configured resolution and off audio by default, normalizing duration", () => {
    expect(resolveKlingSettings(base({ durationSec: 7 }))).toEqual({
      resolution: "720p",
      audio: "off",
      durationSec: 10,
    });
  });

  it("forces 1080p when audio is native, even if KLING_VIDEO_RESOLUTION says 720p", () => {
    vi.stubEnv("KLING_VIDEO_AUDIO", "native");
    vi.stubEnv("KLING_VIDEO_RESOLUTION", "720p");
    expect(resolveKlingSettings(base({ durationSec: 5, generateAudio: true }))).toEqual({
      resolution: "1080p",
      audio: "native",
      durationSec: 5,
    });
  });

  it("honours the user's 无声 choice on a native-audio instance and keeps the instance resolution", () => {
    vi.stubEnv("KLING_VIDEO_AUDIO", "native");
    vi.stubEnv("KLING_VIDEO_RESOLUTION", "720p");
    expect(resolveKlingSettings(base({ durationSec: 5, generateAudio: false }))).toEqual({
      resolution: "720p",
      audio: "off",
      durationSec: 5,
    });
  });

  it("ignores a 有声 request when the instance does not allow audio", () => {
    vi.stubEnv("KLING_VIDEO_AUDIO", "off");
    expect(resolveKlingSettings(base({ durationSec: 5, generateAudio: true })).audio).toBe("off");
  });
});

describe("mapToKlingRequest — text_to_video golden body", () => {
  it("maps to /text-to-video/<model> with only prompt, settings and options", () => {
    const { path, body } = mapToKlingRequest(base({ aspectRatio: "16:9", durationSec: 5 }));
    expect(path).toBe("/text-to-video/kling-2.6");
    expect(body).toEqual({
      prompt: "rain on the bund",
      settings: { audio: "off", resolution: "720p", aspect_ratio: "16:9", duration: 5 },
      options: { external_task_id: "job_test", watermark_info: { enabled: false } },
    });
  });

  it("defaults the aspect ratio to 16:9 when the caller sends none", () => {
    const { body } = mapToKlingRequest(base({ durationSec: 5 }));
    expect(body.settings).toMatchObject({ aspect_ratio: "16:9" });
  });

  it("carries a non-default duration and resolution through to settings", () => {
    vi.stubEnv("KLING_VIDEO_RESOLUTION", "1080p");
    const { body } = mapToKlingRequest(base({ aspectRatio: "9:16", durationSec: 8 }));
    expect(body).toEqual({
      prompt: "rain on the bund",
      settings: { audio: "off", resolution: "1080p", aspect_ratio: "9:16", duration: 10 },
      options: { external_task_id: "job_test", watermark_info: { enabled: false } },
    });
  });

  it("rejects an aspect ratio outside 16:9 / 9:16 / 1:1", () => {
    const error = captureError(() => mapToKlingRequest(base({ aspectRatio: "4:3", durationSec: 5 })));
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects a blank prompt", () => {
    const error = captureError(() => mapToKlingRequest(base({ prompt: "  ", aspectRatio: "16:9" })));
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });
});

describe("mapToKlingRequest — image_to_video golden body", () => {
  it("maps to /image-to-video/<model> with contents + settings (no aspect_ratio)", () => {
    const { path, body } = mapToKlingRequest(
      base({
        mode: "image_to_video",
        prompt: "a cat walks across the frame",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
        durationSec: 10,
      }),
    );
    expect(path).toBe("/image-to-video/kling-2.6");
    expect(body).toEqual({
      contents: [
        { type: "prompt", text: "a cat walks across the frame" },
        { type: "first_frame", url: "data:image/jpeg;base64,aaa" },
      ],
      settings: { audio: "off", resolution: "720p", duration: 10 },
      options: { external_task_id: "job_test", watermark_info: { enabled: false } },
    });
  });

  it("accepts a plain https URL for the first frame, not only a data URI", () => {
    const { body } = mapToKlingRequest(
      base({
        mode: "image_to_video",
        prompt: "p",
        startImage: { kind: "url", url: "https://example.com/frame.jpg" },
      }),
    );
    expect(body.contents).toEqual([
      { type: "prompt", text: "p" },
      { type: "first_frame", url: "https://example.com/frame.jpg" },
    ]);
  });

  it("omits the prompt entry when the prompt is blank, unlike text_to_video", () => {
    const { body } = mapToKlingRequest(
      base({
        mode: "image_to_video",
        prompt: "   ",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,zzz" },
      }),
    );
    expect(body.contents).toEqual([{ type: "first_frame", url: "data:image/jpeg;base64,zzz" }]);
  });

  it("rejects image_to_video with no first frame", () => {
    const error = captureError(() => mapToKlingRequest(base({ mode: "image_to_video", prompt: "walk forward" })));
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects a first frame that isn't a data URI or URL (e.g. a bare file_id)", () => {
    const error = captureError(() =>
      mapToKlingRequest(
        base({
          mode: "image_to_video",
          prompt: "p",
          startImage: { kind: "file_id", fileId: "file_abc" },
        }),
      ),
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });
});

describe("mapToKlingRequest — unsupported modes", () => {
  it("rejects every mode other than text_to_video / image_to_video", () => {
    for (const mode of ["reference_to_video", "edit_video", "extend_video", "text_to_image"] as const) {
      const error = captureError(() => mapToKlingRequest(base({ mode, prompt: "p" })));
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 400, code: "unsupported_mode" });
    }
  });
});

describe("mapToKlingRequest — hard constraint: no last_frame, no callback_url", () => {
  it("never includes last_frame or callback_url in a generated body", () => {
    const t2v = mapToKlingRequest(base({ aspectRatio: "9:16", durationSec: 10 }));
    const i2v = mapToKlingRequest(
      base({
        mode: "image_to_video",
        prompt: "walk forward",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
      }),
    );
    for (const call of [t2v, i2v]) {
      const serialized = JSON.stringify(call.body);
      expect(serialized).not.toMatch(/last_frame/);
      expect(serialized).not.toMatch(/callback_url/);
    }
  });
});

describe("mapKlingTask", () => {
  it("reports pending at 5% while submitted and 40% while processing", () => {
    expect(mapKlingTask({ id: "t1", status: "submitted" })).toMatchObject({ status: "pending", progress: 5 });
    expect(mapKlingTask({ id: "t1", status: "processing" })).toMatchObject({ status: "pending", progress: 40 });
  });

  it("reports done with the first video output once succeeded, skipping non-video outputs", () => {
    const poll = mapKlingTask({
      id: "t1",
      status: "succeeded",
      outputs: [
        { type: "thumbnail", url: "https://cdn.klingai.com/thumb.jpg" },
        { type: "video", url: "https://cdn.klingai.com/out.mp4", duration: 5 },
      ],
    });
    expect(poll).toMatchObject({
      status: "done",
      progress: 100,
      remoteUrl: "https://cdn.klingai.com/out.mp4",
      durationSec: 5,
    });
  });

  it("surfaces the upstream message as a kling_failed error", () => {
    const poll = mapKlingTask({ id: "t1", status: "failed", message: "内容审核未通过" });
    expect(poll).toMatchObject({
      status: "failed",
      progress: 0,
      errorCode: "kling_failed",
      errorMessage: "内容审核未通过",
    });
  });
});

describe("mapKlingTask billing", () => {
  const succeededWith = (billing?: unknown) => ({
    id: "t1",
    status: "succeeded",
    outputs: [{ type: "video", url: "https://cdn.klingai.com/out.mp4", duration: 5 }],
    ...(billing !== undefined ? { billing } : {}),
  });

  it("converts unit billing through KLING_USD_PER_UNIT (0.3/s × 5s = 1.5 units × $0.10 = $0.15)", () => {
    const poll = mapKlingTask(succeededWith([{ charge_type: "unit", amount: 1.5, package_type: "resource_pack" }]));
    expect(poll.usage?.costUsdActual).toBeCloseTo(0.15, 6);
  });

  it("sums multiple unit billing lines before converting", () => {
    const poll = mapKlingTask(
      succeededWith([
        { charge_type: "unit", amount: 1 },
        { charge_type: "unit", amount: 0.5 },
      ]),
    );
    expect(poll.usage?.costUsdActual).toBeCloseTo(0.15, 6);
  });

  it("sums USD cash billing directly, without a unit conversion", () => {
    const poll = mapKlingTask(
      succeededWith([
        { charge_type: "cash", amount: 0.2, currency: "USD" },
        { charge_type: "cash", amount: 0.22, currency: "USD" },
      ]),
    );
    expect(poll.usage?.costUsdActual).toBeCloseTo(0.42, 6);
  });

  it("does not book a CNY cash charge as costUsdActual (wrong currency, kept only in raw)", () => {
    const poll = mapKlingTask(succeededWith([{ charge_type: "cash", amount: 1, currency: "CNY" }]));
    expect(poll.usage?.costUsdActual).toBeUndefined();
    expect(poll.usage?.raw).toBeDefined();
  });

  it("leaves usage unset when the task carries no billing at all", () => {
    const poll = mapKlingTask(succeededWith());
    expect(poll.usage).toBeUndefined();
  });
});
