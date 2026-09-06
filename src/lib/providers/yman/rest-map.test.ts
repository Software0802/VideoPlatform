import { afterEach, describe, expect, it, vi } from "vitest";
import { mapToYmanRequest, mapYmanTask, resolveYmanSettings, ymanSize } from "./rest-map";
import type { ProviderGenerateRequest } from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

// catalog.ts 的键是 `/v1/models` 展示名（发给上游的那一串）；旧的内部名（如
// `minimax_h3_t2v`）降级成了 alias，仍能作为输入被认出，但不再是权威输出——见
// catalog.test.ts 的 resolveModel 测试。这里只用展示名做输出断言。
const T2V_DISPLAY = "minimax-H3 文字";
const REF2V_DISPLAY = "minimax-h3-933-图文";
const SEEDANCE_DISPLAY = "SD2.0 满血";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * `model: ""` on purpose: it forces `resolveYmanSettings` down its real default path
 * (`modelFor(mode)` via `YMAN_T2V_MODEL` / `YMAN_I2V_MODEL`) unless a test overrides it,
 * which mirrors how every other field here defaults when the caller doesn't set it.
 */
function base(over: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    jobId: "job_test",
    mode: "text_to_video",
    prompt: "海上日出，长镜头",
    model: "",
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

describe("resolveYmanSettings", () => {
  it("defaults to YMAN_T2V_MODEL for text_to_video and YMAN_I2V_MODEL for image/reference to video", () => {
    expect(resolveYmanSettings(base({ durationSec: 5 })).model).toBe(T2V_DISPLAY);
    expect(resolveYmanSettings(base({ mode: "image_to_video", durationSec: 5 })).model).toBe(
      REF2V_DISPLAY,
    );
    expect(resolveYmanSettings(base({ mode: "reference_to_video", durationSec: 5 })).model).toBe(
      REF2V_DISPLAY,
    );
  });

  it("honours a YMAN_T2V_MODEL override, resolved through modelFor to the current display name", () => {
    vi.stubEnv("YMAN_T2V_MODEL", "seedance2.0"); // legacy alias
    expect(resolveYmanSettings(base({ durationSec: 10 })).model).toBe(SEEDANCE_DISPLAY);
  });

  it("resolves an explicit req.model through the same alias table as modelFor", () => {
    // req.model="seedance2.0" is a legacy alias of "SD2.0 满血" — resolveYmanSettings must
    // send the current /v1/models display name upstream, not whatever internal name a
    // caller (e.g. a retry replaying an old job.model) happens to pass in.
    expect(resolveYmanSettings(base({ model: "seedance2.0", durationSec: 10 })).model).toBe(
      SEEDANCE_DISPLAY,
    );
  });

  it("always settles on 720p — no catalog model currently lists 1080p, even if asked for it", () => {
    expect(resolveYmanSettings(base({ durationSec: 5 })).resolution).toBe("720p");
    expect(resolveYmanSettings(base({ durationSec: 5, resolution: "1080p" })).resolution).toBe("720p");
  });

  it("defaults the ratio to the model's first supported ratio, and passes through a supported 9:16 unchanged", () => {
    expect(resolveYmanSettings(base({ durationSec: 5 })).ratio).toBe("16:9");
    expect(resolveYmanSettings(base({ durationSec: 5, aspectRatio: "9:16" })).ratio).toBe("9:16");
  });

  it("normalizes duration through the same ladder as catalog.normalizeYmanDuration (4 -> 5)", () => {
    expect(resolveYmanSettings(base({ durationSec: 4 })).durationSec).toBe(5);
  });

  /**
   * 画幅**不**在这一层归一（不同于时长）：16:9 与 9:16 是两个不同的东西，悄悄换掉
   * 用户选的画幅是交付了另一个东西，不是归一。路由（router.ts 的 `pickVideoProvider`）
   * 应该已经把「这个模型接不下的画幅」挡在前面，换一家接得下的；`resolveYmanSettings`
   * 只是如实把请求的画幅带出来，真正的兜底拒绝在 `mapToYmanRequest`（见下面的
   * describe 块）——两层各管一半，这里先钉住「不归一」这一半。
   */
  it("passes an explicit but unsupported ratio (4:3) straight through unchanged, rather than normalizing it", () => {
    expect(resolveYmanSettings(base({ durationSec: 5, aspectRatio: "4:3" })).ratio).toBe("4:3");
  });
});

describe("ymanSize", () => {
  it("maps the three documented ratio/resolution combinations", () => {
    expect(ymanSize("16:9", "720p")).toBe("1280x720");
    expect(ymanSize("9:16", "720p")).toBe("720x1280");
    expect(ymanSize("1:1", "720p")).toBe("720x720");
  });

  it("scales the same ratios at 1080p", () => {
    expect(ymanSize("16:9", "1080p")).toBe("1920x1080");
    expect(ymanSize("9:16", "1080p")).toBe("1080x1920");
  });
});

describe("mapToYmanRequest — text_to_video golden body", () => {
  it("maps to {model, prompt, seconds, size} only, with seconds/size as strings", () => {
    const { body } = mapToYmanRequest(base({ aspectRatio: "16:9", durationSec: 5 }));
    expect(body).toEqual({
      model: T2V_DISPLAY,
      prompt: "海上日出，长镜头",
      seconds: "5",
      size: "1280x720",
    });
  });

  it("carries a normalized duration and a 9:16 size through to the body", () => {
    const { body } = mapToYmanRequest(base({ aspectRatio: "9:16", durationSec: 4 }));
    expect(body).toEqual({
      model: T2V_DISPLAY,
      prompt: "海上日出，长镜头",
      seconds: "5", // 4s rounds up to the 5s tier
      size: "720x1280",
    });
  });

  it("never includes reference_images for text_to_video", () => {
    const { body } = mapToYmanRequest(base({ durationSec: 5 }));
    expect(Object.keys(body)).not.toContain("reference_images");
  });

  it("rejects a blank prompt", () => {
    const error = captureError(() => mapToYmanRequest(base({ prompt: "   ", durationSec: 5 })));
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });
});

describe("mapToYmanRequest — image_to_video golden body", () => {
  it("adds the start image as a single-element reference_images array", () => {
    const { body } = mapToYmanRequest(
      base({
        mode: "image_to_video",
        prompt: "让画面动起来",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
        durationSec: 6,
      }),
    );
    expect(body).toEqual({
      model: REF2V_DISPLAY,
      prompt: "让画面动起来",
      seconds: "10", // 6s rounds up to the 10s tier on the ref2v ladder
      size: "1280x720",
      reference_images: ["data:image/jpeg;base64,aaa"],
    });
  });

  it("accepts a plain https URL for the first frame, not only a data URI", () => {
    const { body } = mapToYmanRequest(
      base({
        mode: "image_to_video",
        prompt: "p",
        startImage: { kind: "url", url: "https://example.com/frame.jpg" },
        durationSec: 5,
      }),
    );
    expect(body.reference_images).toEqual(["https://example.com/frame.jpg"]);
  });

  it("rejects image_to_video with no first frame and no reference images", () => {
    const error = captureError(() =>
      mapToYmanRequest(base({ mode: "image_to_video", prompt: "walk forward", durationSec: 5 })),
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects a first frame that isn't a data URI or URL (e.g. a bare file_id)", () => {
    const error = captureError(() =>
      mapToYmanRequest(
        base({
          mode: "image_to_video",
          prompt: "p",
          startImage: { kind: "file_id", fileId: "file_abc" },
          durationSec: 5,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects image_to_video outright when YMAN_I2V_MODEL is overridden to a model with no reference-image support", () => {
    vi.stubEnv("YMAN_I2V_MODEL", "minimax_h3_t2v"); // 纯文生模型，maxReferenceImages: 0
    const error = captureError(() =>
      mapToYmanRequest(
        base({
          mode: "image_to_video",
          prompt: "p",
          startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
          durationSec: 5,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });
});

describe("mapToYmanRequest — reference_to_video golden body", () => {
  it("collects every reference image into reference_images, in order", () => {
    const refs = [
      { kind: "data_uri" as const, dataUri: "data:image/jpeg;base64,r0" },
      { kind: "data_uri" as const, dataUri: "data:image/jpeg;base64,r1" },
    ];
    const { body } = mapToYmanRequest(
      base({ mode: "reference_to_video", prompt: "多参考图", referenceImages: refs, durationSec: 5 }),
    );
    expect(body.model).toBe(REF2V_DISPLAY);
    expect(body.reference_images).toEqual(["data:image/jpeg;base64,r0", "data:image/jpeg;base64,r1"]);
  });

  it("prepends the start image before the reference images when both are given", () => {
    const refs = [{ kind: "data_uri" as const, dataUri: "data:image/jpeg;base64,r0" }];
    const { body } = mapToYmanRequest(
      base({
        mode: "reference_to_video",
        prompt: "首帧 + 参考图",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,start" },
        referenceImages: refs,
        durationSec: 5,
      }),
    );
    expect(body.reference_images).toEqual([
      "data:image/jpeg;base64,start",
      "data:image/jpeg;base64,r0",
    ]);
  });

  /**
   * 契约摘要写的是「r2v 用 referenceImages 且 ≤ 9」，读起来像是超过 9 张会被拒绝；
   * 但实际实现（见 rest-map.ts 注释）是本地静默截断到该模型的上限，不抛错——
   * 「本地先截断到该模型的上限，免得把一次会被拒的请求发出去（被受理的请求就已经
   * 预扣积分了）」。这里按*实际*截断行为断言。
   */
  it("truncates reference_images to the model's cap (9) instead of rejecting the extra ones", () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({
      kind: "data_uri" as const,
      dataUri: `data:image/jpeg;base64,ref${i}`,
    }));
    const { body } = mapToYmanRequest(
      base({ mode: "reference_to_video", prompt: "十张参考图", referenceImages: refs, durationSec: 5 }),
    );
    expect(body.reference_images).toEqual(refs.slice(0, 9).map((r) => r.dataUri));
    expect((body.reference_images as string[]).length).toBe(9);
  });

  it("rejects reference_to_video with neither a start image nor reference images", () => {
    const error = captureError(() =>
      mapToYmanRequest(base({ mode: "reference_to_video", prompt: "p", durationSec: 5 })),
    );
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });
});

describe("mapToYmanRequest — unsupported modes", () => {
  it("rejects every mode YMan's video path doesn't serve (edit / extend / text_to_image)", () => {
    for (const mode of ["edit_video", "extend_video", "text_to_image"] as const) {
      const error = captureError(() => mapToYmanRequest(base({ mode, prompt: "p" })));
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({ status: 400, code: "unsupported_mode" });
    }
  });
});

/**
 * 契约与 router.ts 现在一致：「不支持的画幅（4:3 等）抛 400 invalid_argument」。路由的
 * `pickVideoProvider` 本该已经把这种请求换给接得下的 provider；这里是它兜不住时
 * （比如混搭 t2v/i2v 两个模型、并集里有但这个模型没有的画幅）的最后一道防线——
 * 见 rest-map.ts 里 `!caps.ratios.includes(ratio)` 那段注释。
 */
describe("mapToYmanRequest — unsupported aspect ratio", () => {
  it("rejects a ratio the resolved model doesn't list (4:3) with 400 invalid_argument", () => {
    const error = captureError(() => mapToYmanRequest(base({ aspectRatio: "4:3", durationSec: 5 })));
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("accepts 1:1 for a model that lists it (SD2.0 满血) even though the default t2v model doesn't", () => {
    const { body } = mapToYmanRequest(
      base({ model: SEEDANCE_DISPLAY, aspectRatio: "1:1", durationSec: 10 }),
    );
    expect(body).toMatchObject({ model: SEEDANCE_DISPLAY, size: "720x720" });
  });
});

describe("mapToYmanRequest — hard constraint: no last_frame / input_video / callback", () => {
  it("never includes last_frame, input_video or callback in a generated body", () => {
    const t2v = mapToYmanRequest(base({ aspectRatio: "16:9", durationSec: 5 }));
    const i2v = mapToYmanRequest(
      base({
        mode: "image_to_video",
        prompt: "walk forward",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
        durationSec: 5,
      }),
    );
    const r2v = mapToYmanRequest(
      base({
        mode: "reference_to_video",
        prompt: "p",
        referenceImages: [{ kind: "data_uri", dataUri: "data:image/jpeg;base64,r0" }],
        durationSec: 5,
      }),
    );
    for (const call of [t2v, i2v, r2v]) {
      const serialized = JSON.stringify(call.body);
      expect(serialized).not.toMatch(/last_frame/);
      expect(serialized).not.toMatch(/input_video/);
      expect(serialized).not.toMatch(/callback/);
      // 契约里点名的白名单：body 只应含这些键。
      expect(Object.keys(call.body).every((k) => ["model", "prompt", "seconds", "size", "reference_images"].includes(k))).toBe(true);
    }
  });
});

describe("mapYmanTask", () => {
  it("reports pending at 5% while queued and 40% while in_progress", () => {
    expect(mapYmanTask({ id: "t1", status: "queued" })).toMatchObject({ status: "pending", progress: 5 });
    expect(mapYmanTask({ id: "t1", status: "in_progress" })).toMatchObject({ status: "pending", progress: 40 });
  });

  it("also treats an unrecognized/missing status as pending at 5% (future upstream states, timeout backstop)", () => {
    expect(mapYmanTask({ id: "t1", status: "some_future_state" })).toMatchObject({
      status: "pending",
      progress: 5,
    });
    expect(mapYmanTask({ id: "t1" })).toMatchObject({ status: "pending", progress: 5 });
  });

  it("reports done with a content URL ending in /videos/<id>/content once completed", () => {
    const poll = mapYmanTask({ id: "vid_abc", status: "completed" });
    expect(poll.status).toBe("done");
    expect(poll.progress).toBe(100);
    expect(poll.remoteUrl).toBe("https://vip.yman.cc/v1/videos/vid_abc/content");
  });

  it("builds the content URL from the current YMAN_BASE_URL", () => {
    vi.stubEnv("YMAN_BASE_URL", "https://relay.example.com");
    const poll = mapYmanTask({ id: "vid_abc", status: "completed" });
    expect(poll.remoteUrl).toBe("https://relay.example.com/v1/videos/vid_abc/content");
  });

  it("leaves remoteUrl undefined when completed without an id", () => {
    const poll = mapYmanTask({ status: "completed" });
    expect(poll.remoteUrl).toBeUndefined();
  });

  it("surfaces the upstream error code/message when failed", () => {
    const poll = mapYmanTask({
      id: "t1",
      status: "failed",
      error: { code: "content_policy", message: "内容审核未通过" },
    });
    expect(poll).toMatchObject({
      status: "failed",
      progress: 0,
      errorCode: "content_policy",
      errorMessage: "内容审核未通过",
    });
  });

  it("defaults errorCode/errorMessage when failed without an error object", () => {
    const poll = mapYmanTask({ id: "t1", status: "failed" });
    expect(poll).toMatchObject({ status: "failed", errorCode: "yman_failed", errorMessage: "生成失败" });
  });

  it("estimates usage once model/seconds/size are known, and leaves it unset otherwise", () => {
    const task = { id: "t1", status: "completed", model: "seedance2.0", seconds: "10", size: "1280x720" };
    const withModel = mapYmanTask(task);
    // seedance2.0 @ 10s/720p = 450 credits; 450 / 100 / 7.2 (default USD_CNY_RATE) ≈ 0.625.
    expect(withModel.usage?.costUsdActual).toBeCloseTo(0.625, 6);
    expect(withModel.usage?.raw).toBe(task);

    const withoutModel = mapYmanTask({ id: "t1", status: "completed" });
    expect(withoutModel.usage).toBeUndefined();
  });
});

/**
 * 契约 A1：产品目录取代环境变量成为「用户没选时」的默认档，`resolveYmanSettings`
 * 的第二参 `defaults` 就是产品传进来的那一份；用户的 `req.resolution` 仍然优先。
 */
describe("resolveYmanSettings — user resolution & product defaults (契约 A1)", () => {
  it("normalizes a 480p ask up to the model's only tier (720p)", () => {
    expect(resolveYmanSettings(base({ durationSec: 5, resolution: "480p" })).resolution).toBe("720p");
  });

  it("honours an explicit req.resolution the model supports, over the product default", () => {
    vi.stubEnv(
      "YMAN_MODEL_CATALOG",
      JSON.stringify({ "minimax-H3 文字": { resolutions: ["720p", "1080p"] } }),
    );
    const settings = resolveYmanSettings(base({ durationSec: 5, resolution: "1080p" }), { resolution: "720p" });
    expect(settings.resolution).toBe("1080p");
  });

  it("falls back to the product default resolution when the request names none", () => {
    vi.stubEnv(
      "YMAN_MODEL_CATALOG",
      JSON.stringify({ "minimax-H3 文字": { resolutions: ["720p", "1080p"] } }),
    );
    const settings = resolveYmanSettings(base({ durationSec: 5 }), { resolution: "1080p" });
    expect(settings.resolution).toBe("1080p");
  });

  it("without any ask or product default, settles on the model's lowest (cheapest) tier", () => {
    vi.stubEnv(
      "YMAN_MODEL_CATALOG",
      JSON.stringify({ "minimax-H3 文字": { resolutions: ["720p", "1080p"] } }),
    );
    expect(resolveYmanSettings(base({ durationSec: 5 })).resolution).toBe("720p");
  });

  /**
   * 任务书摘要写「请求 1080p 而模型只 720p → 400 或路由跳过」；但 `resolveYmanSettings`
   * 自身的注释（rest-map.ts「一档都不够高时落到该模型最高的一档」那段）明确说这种情况
   * 本该被路由或产品校验挡在前面 400，走到这一层是「别处配错了」的兜底，宁可出片也不
   * 悄悄涨价——所以这一层是静默降级到模型最高档，不是抛错。这里按*当前实现*钉住这条
   * 兜底行为；400 / 跳过这条契约应该在 router.ts（`servesResolutionCap`）与 create.ts
   * 校验层验证，不在 rest-map 这一层重复断言两种互斥的行为。见测试报告「源码疑点」。
   */
  it("gracefully degrades to the model's highest tier when asked exceeds it, rather than throwing (documented fallback)", () => {
    const settings = resolveYmanSettings(base({ durationSec: 5, resolution: "1080p" }));
    expect(settings.resolution).toBe("720p");
  });
});

/**
 * 契约 A1：「r2v 9 张」——ref2v 模型的 `maxReferenceImages` 是 9。已有的
 * "truncates reference_images to the model's cap" 用例覆盖了超量截断；这里补上
 * 恰好 9 张时全部保留、一张都不截断的边界。
 */
describe("mapToYmanRequest — reference_to_video at the 9-image cap", () => {
  it("passes through exactly 9 reference images without truncating any of them", () => {
    const refs = Array.from({ length: 9 }, (_, i) => ({
      kind: "data_uri" as const,
      dataUri: `data:image/jpeg;base64,ref${i}`,
    }));
    const { body } = mapToYmanRequest(
      base({ mode: "reference_to_video", prompt: "九张参考图", referenceImages: refs, durationSec: 5 }),
    );
    expect((body.reference_images as string[]).length).toBe(9);
    expect(body.reference_images).toEqual(refs.map((r) => r.dataUri));
  });
});
