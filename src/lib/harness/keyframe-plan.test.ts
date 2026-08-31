import { describe, expect, it } from "vitest";
import { applyKeyframeLocks } from "./keyframe-plan";
import type { HarnessPlan } from "./types";

const plan: HarnessPlan = {
  targetDurationSec: 30,
  packing: {
    clips: [
      { kind: "generate", durationSec: 15 },
      { kind: "extend", durationSec: 10 },
      { kind: "generate", durationSec: 5 },
    ],
  },
  bible: {
    version: 1,
    logline: "雨夜电影院",
    style: {
      palette: ["amber"],
      lighting: "tungsten",
      lens: "35mm",
      era: "now",
      doNotChange: ["identity"],
    },
    characters: [],
    locations: [],
    props: [],
  },
  shots: [
    {
      id: "shot_0",
      index: 0,
      durationSec: 15,
      prompt: "走进电影院",
      characterIds: [],
      startFrame: { source: "generated", assetId: "generated-start" },
      route: "grok_i2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
    {
      id: "shot_1",
      index: 1,
      durationSec: 10,
      prompt: "继续向前",
      characterIds: [],
      startFrame: { source: "generated", assetId: "old-start" },
      route: "grok_i2v",
      continuity: "tail_chain",
      generateAudio: false,
    },
    {
      id: "shot_2",
      index: 2,
      durationSec: 5,
      prompt: "停在银幕前",
      characterIds: [],
      route: "grok_t2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
  ],
  stitch: { transition: "hard_cut", settleLastFrame: false },
};

describe("keyframe plan", () => {
  it("applies user locks and replaces non-user tail-chain starts", () => {
    const result = applyKeyframeLocks(plan, {
      userStartAssetId: "user-start.jpg",
      userLastAssetId: "user-last.jpg",
      extractedTailFrames: { "0": "shots/0/link.jpg" },
    });

    expect(result.shots[0]?.startFrame).toEqual({ source: "user", assetId: "user-start.jpg" });
    expect(result.shots[1]?.startFrame).toEqual({ source: "extracted", assetId: "shots/0/link.jpg" });
    expect(result.shots[2]?.endFrame).toEqual({ source: "user", assetId: "user-last.jpg" });
    expect(plan.shots[0]?.startFrame?.source).toBe("generated");
    expect(plan.shots[1]?.startFrame?.source).toBe("generated");
  });

  it("rejects a tail-chain shot without a usable extracted frame", () => {
    expect(() => applyKeyframeLocks(plan, { userStartAssetId: "user-start.jpg" })).toThrow(
      "缺少 tail-chain 抽取帧",
    );
  });

  it("rejects empty explicit asset identifiers", () => {
    expect(() => applyKeyframeLocks(plan, { userStartAssetId: "" })).toThrow("帧资产无效");
  });
});
