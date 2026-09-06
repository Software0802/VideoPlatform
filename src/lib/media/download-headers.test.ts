import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadHeadersFor } from "./download-headers";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("downloadHeadersFor", () => {
  it("sends the xAI Bearer token for a URL on the configured xAI origin", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    expect(downloadHeadersFor("https://api.x.ai/v1/files/abc/content")).toEqual({
      Authorization: "Bearer xai-test-key",
    });
  });

  it("sends the YMan Bearer token for a URL on the configured YMan origin", () => {
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content")).toEqual({
      Authorization: "Bearer yman-test-key",
    });
  });

  it("never sends the xAI key to the YMan origin, or the YMan key to the xAI origin, even when both are configured", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content")).toEqual({
      Authorization: "Bearer yman-test-key",
    });
    expect(downloadHeadersFor("https://api.x.ai/v1/files/abc/content")).toEqual({
      Authorization: "Bearer xai-test-key",
    });
  });

  it("respects a custom YMAN_BASE_URL origin instead of the hardcoded default", () => {
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    vi.stubEnv("YMAN_BASE_URL", "https://relay.example.com/v1");
    expect(downloadHeadersFor("https://relay.example.com/videos/vid_1/content")).toEqual({
      Authorization: "Bearer yman-test-key",
    });
    // The old default origin no longer matches once YMAN_BASE_URL points elsewhere.
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content")).toEqual({});
  });

  it("sends no header for an unrecognized origin, e.g. a third-party CDN URL", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://cdn.example.com/video.mp4")).toEqual({});
  });

  it("sends no header when the matching origin has no key configured", () => {
    vi.stubEnv("XAI_API_KEY", undefined);
    vi.stubEnv("SUB2API_API_KEY", undefined);
    vi.stubEnv("YMAN_API_KEY", undefined);
    expect(downloadHeadersFor("https://api.x.ai/v1/files/abc/content")).toEqual({});
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content")).toEqual({});
  });

  it("sends no header for an unparseable URL instead of throwing", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("not a url")).toEqual({});
  });
});
