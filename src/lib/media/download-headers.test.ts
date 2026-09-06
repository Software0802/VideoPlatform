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

/**
 * `providerId` (the job's own `job.provider`, per `runner.ts` / harness callers): once given,
 * it is a *stricter* gate than origin matching alone — the URL's origin must belong to
 * *that specific* provider's configured upstream, not just to some provider's upstream.
 *
 * This guards against a job recorded as one provider (e.g. after `switchAwayFromExhausted`
 * moves it, or a bad/attacker-influenced remote URL) carrying a `remoteUrl` that happens to
 * sit on a *different* configured provider's origin — without the providerId check, origin
 * matching alone would still hand out that other provider's Bearer token.
 */
describe("downloadHeadersFor with an explicit providerId", () => {
  it("withholds the header when providerId names grok but the URL sits on the YMan origin", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    // Origin-only matching (no providerId) would hand out the YMan key here; naming "grok"
    // must refuse instead of falling back to whichever provider the origin happens to match.
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content")).toEqual({
      Authorization: "Bearer yman-test-key",
    });
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content", "grok")).toEqual({});
  });

  it("sends the YMan Bearer token when providerId names yman and the URL sits on the YMan origin", () => {
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content", "yman")).toEqual({
      Authorization: "Bearer yman-test-key",
    });
  });

  it("sends the xAI Bearer token when providerId names grok and the URL sits on the xAI origin", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://api.x.ai/v1/files/abc/content", "grok")).toEqual({
      Authorization: "Bearer xai-test-key",
    });
  });

  it("sends no header for a provider that never needs auth to download (kling, openai, mock), regardless of origin or configured keys", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://api.x.ai/v1/files/abc/content", "kling")).toEqual({});
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content", "openai")).toEqual({});
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content", "mock")).toEqual({});
  });

  it("still falls back to plain origin matching when providerId is omitted, even after the providerId-aware tests above", () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    vi.stubEnv("YMAN_API_KEY", "yman-test-key");
    expect(downloadHeadersFor("https://api.x.ai/v1/files/abc/content")).toEqual({
      Authorization: "Bearer xai-test-key",
    });
    expect(downloadHeadersFor("https://vip.yman.cc/v1/videos/vid_1/content")).toEqual({
      Authorization: "Bearer yman-test-key",
    });
  });
});
