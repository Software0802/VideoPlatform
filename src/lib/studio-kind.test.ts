import { describe, expect, it } from "vitest";
import {
  defaultsForKind,
  isStudioKind,
  kindTitle,
  studioPath,
} from "./studio-kind";

describe("studio-kind", () => {
  it("accepts image/video/audio only", () => {
    expect(isStudioKind("image")).toBe(true);
    expect(isStudioKind("video")).toBe(true);
    expect(isStudioKind("audio")).toBe(true);
    expect(isStudioKind("system")).toBe(false);
  });

  it("maps kinds to generate defaults", () => {
    expect(defaultsForKind("image")).toEqual({
      mode: "text_to_image",
      generateAudio: false,
    });
    expect(defaultsForKind("video").mode).toBe("text_to_video");
    expect(defaultsForKind("audio").generateAudio).toBe(true);
  });

  it("builds studio paths with encoded prompt", () => {
    expect(studioPath("video")).toBe("/studio/video");
    expect(studioPath("image", "雨夜")).toBe(
      `/studio/image?prompt=${encodeURIComponent("雨夜")}`,
    );
    expect(kindTitle("audio")).toBe("音频工作室");
  });
});
