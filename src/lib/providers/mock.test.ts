import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { mediaStore } from "@/lib/storage/local-fs";
import { mockProvider } from "./mock";

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
});
