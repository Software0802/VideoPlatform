import { describe, expect, it } from "vitest";
import { isMp4Container, parseFfmpegVideoInfo } from "./ffmpeg";

describe("parseFfmpegVideoInfo", () => {
  it("distinguishes MP4 containers from WebM containers", () => {
    expect(isMp4Container("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':")).toBe(true);
    expect(isMp4Container("Input #0, matroska,webm, from 'clip.mp4':")).toBe(false);
  });

  it("uses the stream dimensions instead of the codec tag", () => {
    const stderr =
      "Duration: 00:00:04.00, start: 0.000000, bitrate: 30 kb/s\\n" +
      "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), " +
      "yuv420p(progressive), 1280x720, 26 kb/s, 24 fps";

    expect(parseFfmpegVideoInfo(stderr)).toEqual({ durationSec: 4, width: 1280, height: 720 });
  });

  it("requires a duration but tolerates missing dimensions", () => {
    expect(() => parseFfmpegVideoInfo("Stream #0:0: Video: h264")).toThrow(/时长/);
    expect(parseFfmpegVideoInfo("Duration: 00:00:02.50")).toEqual({
      durationSec: 2.5,
      width: 0,
      height: 0,
    });
  });
});
