import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "@/lib/providers/types";
import { assertCreateJobFields } from "./request-validation";
import type { CreateJobBody } from "./schema";

function body(overrides: Partial<CreateJobBody> = {}): CreateJobBody {
  return {
    mode: "text_to_video",
    prompt: "a quiet cinematic shot",
    ...overrides,
  };
}

describe("create job request validation", () => {
  it("rejects fields that edit and extend cannot send upstream", () => {
    expect(() =>
      assertCreateJobFields(
        body({ mode: "edit_video", durationSec: 4, sourceVideoUploadId: "up_aaaaaaaaaaaaaaaa" }),
      ),
    ).toThrow(ProviderHttpError);
    expect(() =>
      assertCreateJobFields(
        body({ mode: "extend_video", aspectRatio: "16:9", sourceVideoUploadId: "up_aaaaaaaaaaaaaaaa" }),
      ),
    ).toThrow(ProviderHttpError);
  });

  it("rejects assets attached to the wrong mode", () => {
    expect(() =>
      assertCreateJobFields({
        mode: "text_to_video",
        prompt: "shot",
        startUploadId: "up_aaaaaaaaaaaaaaaa",
      }),
    ).toThrow(/首帧/);
    expect(() =>
      assertCreateJobFields({
        mode: "image_to_video",
        prompt: "shot",
        startUploadId: "up_bbbbbbbbbbbbbbbb",
        sourceVideoUploadId: "up_aaaaaaaaaaaaaaaa",
      }),
    ).toThrow(/源视频/);
  });

  it("enforces mode-specific prompts and duration ranges", () => {
    expect(() => assertCreateJobFields(body({ durationSec: 0 }))).toThrow(/1–15/);
    expect(() => assertCreateJobFields(body({ durationSec: 16 }))).toThrow(/1–15/);
    expect(() => assertCreateJobFields(body({ mode: "reference_to_video", prompt: " " }))).toThrow(/提示词/);
    expect(() => assertCreateJobFields(body({ mode: "edit_video", prompt: " " }))).toThrow(/提示词/);
    expect(() => assertCreateJobFields(body({ mode: "extend_video", prompt: " " }))).toThrow(/提示词/);
  });

  it("accepts the optional prompt in image-to-video", () => {
    expect(() =>
      assertCreateJobFields({
        mode: "image_to_video",
        prompt: "",
        startUploadId: "up_aaaaaaaaaaaaaaaa",
        durationSec: 8,
        aspectRatio: "16:9",
        resolution: "720p",
      }),
    ).not.toThrow();
  });

  it("rejects duplicate reference assets", () => {
    expect(() =>
      assertCreateJobFields(
        body({
          mode: "reference_to_video",
          referenceUploadIds: ["up_aaaaaaaaaaaaaaaa", "up_aaaaaaaaaaaaaaaa"],
        }),
      ),
    ).toThrow(/参考图不能重复/);
    expect(() =>
      assertCreateJobFields(
        body({
          mode: "reference_to_video",
          voiceIds: ["eve", "eve"],
        }),
      ),
    ).toThrow(/参考音色不能重复/);
  });
});
