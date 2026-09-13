import { describe, expect, it } from "vitest";
import { packHarnessDuration } from "./pack-duration";
import { harnessOrchestrator } from "./orchestrator";

describe("packHarnessDuration", () => {
  it("packs 30s into three 10s generate clips", () => {
    expect(packHarnessDuration(30)).toEqual([
      { kind: "generate", durationSec: 10 },
      { kind: "generate", durationSec: 10 },
      { kind: "generate", durationSec: 10 },
    ]);
  });

  it("packs 45s and 60s into generate-only 5/10s clips", () => {
    expect(packHarnessDuration(45).map((c) => c.durationSec)).toEqual([10, 10, 10, 10, 5]);
    expect(packHarnessDuration(60).map((c) => c.durationSec)).toEqual([10, 10, 10, 10, 10, 10]);
    for (const target of [45, 60] as const) {
      const clips = packHarnessDuration(target);
      expect(clips.reduce((sum, clip) => sum + clip.durationSec, 0)).toBe(target);
      expect(clips.every((clip) => clip.kind === "generate")).toBe(true);
      expect(clips.every((clip) => clip.durationSec === 5 || clip.durationSec === 10)).toBe(true);
    }
  });
});

describe("orchestrator", () => {
  it("always throws in phase 1", async () => {
    await expect(harnessOrchestrator.execute("job_x")).rejects.toThrow("HARNESS_NOT_ENABLED");
  });
});
