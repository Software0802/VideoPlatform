import { describe, expect, it } from "vitest";
import { packDuration, packHarnessDuration } from "./pack-duration";
import { harnessOrchestrator } from "./orchestrator";

describe("packDuration", () => {
  it("keeps 8s as one shot", () => {
    expect(packDuration(8)).toEqual([8]);
  });
  it("splits 24s into 8s shots", () => {
    expect(packDuration(24)).toEqual([8, 8, 8]);
  });
  it("splits 15s", () => {
    const shots = packDuration(15);
    expect(shots.reduce((a, b) => a + b, 0)).toBe(15);
    expect(shots.every((s) => s >= 4 && s <= 12)).toBe(true);
  });
});

describe("packHarnessDuration", () => {
  it("uses the 30s generate-extend-tail recommendation", () => {
    expect(packHarnessDuration(30)).toEqual([
      { kind: "generate", durationSec: 15 },
      { kind: "extend", durationSec: 10 },
      { kind: "generate", durationSec: 5 },
    ]);
  });

  it("keeps every clip within provider limits for 45s and 60s", () => {
    for (const target of [45, 60] as const) {
      const clips = packHarnessDuration(target);
      expect(clips.reduce((sum, clip) => sum + clip.durationSec, 0)).toBe(target);
      expect(clips.every((clip) => clip.durationSec <= (clip.kind === "extend" ? 10 : 15))).toBe(true);
    }
  });
});

describe("orchestrator", () => {
  it("always throws in phase 1", async () => {
    await expect(harnessOrchestrator.execute("job_x")).rejects.toThrow("HARNESS_NOT_ENABLED");
  });
});
