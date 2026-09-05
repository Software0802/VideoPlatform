import { describe, expect, it } from "vitest";
import { mockDirectorPlan } from "./mock-director";
import { applyKeyframeLocks } from "./keyframe-plan";

describe("mock director", () => {
  it("packs 30/45/60 into 15s generate clips chained by tail-chain I2V", () => {
    for (const target of [30, 45, 60] as const) {
      const plan = mockDirectorPlan({ prompt: "雨夜外滩", targetDurationSec: target });
      expect(plan.shots.reduce((s, x) => s + x.durationSec, 0)).toBe(target);
      expect(plan.packing.clips.every((c) => c.kind === "generate")).toBe(true);
      expect(plan.shots[0]!.route).toBe("grok_t2v");
      expect(plan.shots.slice(1).every((s) => s.route === "grok_i2v" && s.continuity === "tail_chain")).toBe(true);
    }
  });

  it("uses the user start frame on shot 0 and settles when a last frame exists", () => {
    const plan = mockDirectorPlan({
      prompt: "x",
      targetDurationSec: 30,
      hasStartFrame: true,
      hasLastFrame: true,
    });
    expect(plan.shots[0]).toMatchObject({ route: "grok_i2v", startFrame: { source: "user" } });
    expect(plan.stitch.settleLastFrame).toBe(true);
    const locked = applyKeyframeLocks(plan, {
      userStartAssetId: "inputs/start.jpg",
      userLastAssetId: "inputs/last.jpg",
      extractedTailFrames: { "0": "shots/0/tail.jpg" },
    });
    expect(locked.shots[1]!.startFrame).toEqual({ source: "extracted", assetId: "shots/0/tail.jpg" });
    expect(locked.shots[1]!.endFrame).toEqual({ source: "user", assetId: "inputs/last.jpg" });
  });
});
