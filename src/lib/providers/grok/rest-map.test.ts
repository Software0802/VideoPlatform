import { describe, expect, it } from "vitest";
import { mapToGrokRest } from "./rest-map";
import type { ProviderGenerateRequest } from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

function base(over: Partial<ProviderGenerateRequest>): ProviderGenerateRequest {
  return {
    jobId: "job_test",
    mode: "text_to_video",
    prompt: "rain on the bund",
    model: "grok-imagine-video-1.5",
    generateAudio: true,
    ...over,
  };
}

describe("rest-map", () => {
  it("T2V omits generate_audio when true", () => {
    const { body, path } = mapToGrokRest(base({ generateAudio: true, durationSec: 8 }));
    expect(path).toBe("/videos/generations");
    expect(body.generate_audio).toBeUndefined();
    expect(body.prompt).toBe("rain on the bund");
    expect(JSON.stringify(body)).not.toMatch(/last\.jpg|lastFrame/);
  });

  it("I2V omits empty prompt and never sends last frame", () => {
    const { body } = mapToGrokRest(
      base({
        mode: "image_to_video",
        prompt: "  ",
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aaa" },
      }),
    );
    expect(body.prompt).toBeUndefined();
    expect(body.image).toEqual({ url: "data:image/jpeg;base64,aaa" });
    expect(JSON.stringify(body)).not.toMatch(/last/);
  });

  it("rejects R2V 1080p", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "reference_to_video",
          resolution: "1080p",
          referenceImages: [{ kind: "data_uri", dataUri: "data:image/jpeg;base64,a" }],
        }),
      ),
    ).toThrow(ProviderHttpError);
  });

  it("rejects 1.5 + source video", () => {
    expect(() =>
      mapToGrokRest(
        base({
          sourceVideo: { kind: "file_id", fileId: "file_1" },
        }),
      ),
    ).toThrow(/源视频/);
  });

  it("rejects edit + duration", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "edit_video",
          model: "grok-imagine-video",
          durationSec: 5,
          sourceVideo: { kind: "file_id", fileId: "file_1" },
        }),
      ),
    ).toThrow(ProviderHttpError);
  });

  it("rejects extend + aspect", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "extend_video",
          model: "grok-imagine-video",
          durationSec: 6,
          aspectRatio: "16:9",
          sourceVideo: { kind: "file_id", fileId: "file_1" },
        }),
      ),
    ).toThrow(ProviderHttpError);
  });

  it("rejects 30s harness duration", () => {
    expect(() => mapToGrokRest(base({ durationSec: 30 }))).toThrow(/一致性管线/);
  });

  it("T2I maps to images/generations without video fields", () => {
    const { body, path } = mapToGrokRest(
      base({
        mode: "text_to_image",
        model: "grok-imagine-image-2.0",
        generateAudio: false,
        aspectRatio: "16:9",
        imageResolution: "1k",
      }),
    );
    expect(path).toBe("/images/generations");
    expect(body.prompt).toBe("rain on the bund");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("1k");
    expect(body.duration).toBeUndefined();
    expect(body.generate_audio).toBeUndefined();
    expect(body.image).toBeUndefined();
    expect(body.video).toBeUndefined();
    expect(body.storage_options).toEqual({ filename: "job_test.jpg" });
  });

  it("edit with file_id maps video.file_id and never a data URI", () => {
    const { body, path } = mapToGrokRest(
      base({
        mode: "edit_video",
        model: "grok-imagine-video",
        sourceVideo: { kind: "file_id", fileId: "file_abc" },
      }),
    );
    expect(path).toBe("/videos/edits");
    expect(body.video).toEqual({ file_id: "file_abc" });
    expect(JSON.stringify(body)).not.toMatch(/data:video/);
  });

  it("rejects source video data URI", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "edit_video",
          model: "grok-imagine-video",
          sourceVideo: { kind: "data_uri", dataUri: "data:video/mp4;base64,aaaa" },
        }),
      ),
    ).toThrow(/file_id|源视频/);
  });

  it("rejects empty T2I prompt", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "text_to_image",
          model: "grok-imagine-image-2.0",
          prompt: "  ",
          generateAudio: false,
        }),
      ),
    ).toThrow(/文生图/);
  });

  it("rejects generation durations outside 1–15 seconds", () => {
    expect(() => mapToGrokRest(base({ durationSec: 0 }))).toThrow(/时长/);
    expect(() => mapToGrokRest(base({ durationSec: 16 }))).toThrow(/时长/);
  });

  it("requires prompts for reference, edit, and extend modes", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "reference_to_video",
          prompt: " ",
          referenceImages: [{ kind: "data_uri", dataUri: "data:image/jpeg;base64,a" }],
        }),
      ),
    ).toThrow(/提示词/);
    expect(() =>
      mapToGrokRest(
        base({
          mode: "edit_video",
          model: "grok-imagine-video",
          prompt: " ",
          sourceVideo: { kind: "file_id", fileId: "file_1" },
        }),
      ),
    ).toThrow(/提示词/);
    expect(() =>
      mapToGrokRest(
        base({
          mode: "extend_video",
          model: "grok-imagine-video",
          prompt: " ",
          durationSec: 6,
          sourceVideo: { kind: "file_id", fileId: "file_1" },
        }),
      ),
    ).toThrow(/提示词/);
  });

  it("rejects media fields that do not belong to the selected video mode", () => {
    expect(() =>
      mapToGrokRest(
        base({
          startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,a" },
        }),
      ),
    ).toThrow(/首帧/);
    expect(() =>
      mapToGrokRest(
        base({
          mode: "image_to_video",
          startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,a" },
          referenceImages: [{ kind: "data_uri", dataUri: "data:image/jpeg;base64,b" }],
        }),
      ),
    ).toThrow(/参考/);
    expect(() =>
      mapToGrokRest(
        base({
          imageResolution: "1k",
        }),
      ),
    ).toThrow(/图片分辨率/);
  });

  it("requires an integer extension duration", () => {
    expect(() =>
      mapToGrokRest(
        base({
          mode: "extend_video",
          model: "grok-imagine-video",
          durationSec: 2.5,
          sourceVideo: { kind: "file_id", fileId: "file_1" },
        }),
      ),
    ).toThrow(/2–10/);
  });

  /**
   * 契约 A1：`ProviderGenerateRequest` 新增了 `lastImage?`（可灵用它发首尾帧），但 grok
   * 的 `capabilities().supportsLastFrameLock` 恒为 false——「尾帧只落盘，永不进入 Grok
   * 请求体」这条硬约束现在具体落在 `assertModeConstraints` 里：带 lastImage 的请求直接
   * 400，而不是被默默丢弃。默默丢弃会让用户以为尾帧生效、实际却收了钱没锁尾帧。
   */
  it("rejects a lastImage on image_to_video with 400 invalid_argument, mentioning 首尾帧", () => {
    const req = base({
      mode: "image_to_video",
      startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,a" },
      lastImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,SENTINEL_LAST_FRAME" },
    });
    expect(() => mapToGrokRest(req)).toThrow(ProviderHttpError);
    expect(() => mapToGrokRest(req)).toThrow(/首尾帧/);
  });

  it("rejects a lastImage even on text_to_video, where it is doubly meaningless", () => {
    const req = base({
      durationSec: 5,
      lastImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,x" },
    });
    expect(() => mapToGrokRest(req)).toThrow(ProviderHttpError);
  });
});
