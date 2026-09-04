import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { mediaStore } from "@/lib/storage/local-fs";
import { MOCK_FAIL_MARKER, mockProvider } from "./mock";

const jobId = "job_mock_stage_test";

afterEach(async () => {
  await rm(mediaStore.jobDir(jobId), { recursive: true, force: true });
});

describe("mockProvider local output", () => {
  it("stages image output outside the public outputs directory", async () => {
    const handle = await mockProvider.submit({
      jobId,
      mode: "text_to_image",
      model: "grok-imagine-image",
      prompt: "a quiet mountain lake",
      generateAudio: false,
    });

    expect(handle.localVideoPath?.startsWith("tmp/")).toBe(true);
  });

  it("rejects submit with an upstream error when the prompt carries the fail marker", async () => {
    await expect(
      mockProvider.submit({
        jobId,
        mode: "text_to_video",
        model: "grok-imagine-video-1.5",
        prompt: `a storm ${MOCK_FAIL_MARKER}`,
        durationSec: 1,
        aspectRatio: "16:9",
        generateAudio: false,
      }),
    ).rejects.toMatchObject({ code: "mock_failure", status: 502 });
  });
});
