import { describe, expect, it } from "vitest";
import { createJobBodySchema, jobPublicSchema } from "./schema";
import { toPublic } from "./store";
import type { JobRecord } from "./schema";

function rec(over: Partial<JobRecord> = {}): JobRecord {
  return {
    schemaVersion: 1,
    id: "job_x",
    status: "succeeded",
    progress: 100,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "x",
    durationSec: 4,
    aspectRatio: "16:9",
    resolution: "720p",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    costUsdEstimate: 0.32,
    costUsdActual: null,
    imageResolution: null,
    error: null,
    output: {
      kind: "video",
      videoUrl: "/api/media/job_x/video.mp4",
      posterUrl: "/api/media/job_x/poster.jpg",
      durationSec: 4,
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
}

describe("JobPublic", () => {
  it("accepts video and image outputs", () => {
    expect(jobPublicSchema.parse(toPublic(rec())).output?.kind).toBe("video");
    const img = rec({
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      durationSec: 0,
      resolution: null,
      imageResolution: "1k",
      output: { kind: "image", imageUrl: "/api/media/job_x/image.jpg" },
    });
    expect(toPublic(img).output).toEqual({
      kind: "image",
      imageUrl: "/api/media/job_x/image.jpg",
    });
  });

  it("rejects path-traversal and malformed upload ids", () => {
    expect(() =>
      createJobBodySchema.parse({ mode: "image_to_video", startUploadId: "..\\..\\foo" }),
    ).toThrow();
    expect(() =>
      createJobBodySchema.parse({ mode: "edit_video", sourceVideoUploadId: "up_nothex!!" }),
    ).toThrow();
    expect(
      createJobBodySchema.parse({
        mode: "image_to_video",
        startUploadId: `up_${"ab".repeat(8)}`,
      }).startUploadId,
    ).toBe("up_abababababababab");
  });

  it("rejects unknown create-job fields instead of stripping them", () => {
    expect(() =>
      createJobBodySchema.parse({ mode: "text_to_video", prompt: "x", typo_field: true }),
    ).toThrow();
  });

  it("caps prompt length at the UI contract boundary", () => {
    expect(() =>
      createJobBodySchema.parse({ mode: "text_to_video", prompt: "x".repeat(2001) }),
    ).toThrow();
  });

  it("exposes artifactsPurgedAt so the works ring can show a placeholder", () => {
    // Absent on every job that still has its bytes — the DTO says so with null,
    // never by omitting the field (the browser must not have to guess).
    expect(toPublic(rec()).artifactsPurgedAt).toBeNull();

    const purged = rec({ artifactsPurgedAt: "2026-09-06T04:00:00.000Z" });
    const pub = toPublic(purged);
    expect(pub.artifactsPurgedAt).toBe("2026-09-06T04:00:00.000Z");
    // Retention is a second axis: the execution status is untouched (plan §8).
    expect(pub.status).toBe("succeeded");
  });

  it("coerces legacy video output without kind", () => {
    const legacy = rec({
      output: {
        videoUrl: "/api/media/job_x/video.mp4",
        posterUrl: "/api/media/job_x/poster.jpg",
        durationSec: 4,
      } as JobRecord["output"],
    });
    expect(toPublic(legacy).output?.kind).toBe("video");
  });
});
