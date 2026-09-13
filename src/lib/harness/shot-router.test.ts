import { describe, expect, it } from "vitest";
import { mapToGrokRest } from "@/lib/providers/grok/rest-map";
import type { IdentityBible, Shot } from "./types";
import { buildShotRequest, type ProviderCaps } from "./shot-router";

const bible: IdentityBible = {
  version: 1,
  logline: "雨夜电影院",
  style: {
    palette: ["amber"],
    lighting: "tungsten",
    lens: "35mm",
    era: "now",
    doNotChange: ["identity"],
  },
  characters: [
    {
      id: "char_main",
      name: "林",
      lockedTraits: ["navy coat"],
      sheetAssetIds: ["inputs/sheets/character-0.jpg"],
    },
  ],
  locations: [
    { id: "loc_cinema", name: "电影院", refAssetIds: ["inputs/locations/cinema.jpg"] },
  ],
  props: [],
};

const resolveAsset = (assetId: string) => ({
  kind: "data_uri" as const,
  dataUri: `data:image/jpeg;base64,${assetId}`,
});

const caps: ProviderCaps = {
  modes: ["text_to_video", "image_to_video", "reference_to_video"],
  durations: [5, 10],
  maxDurationSec: 10,
  maxReferenceImages: 7,
  supportsLastFrameLock: false,
  maxResolution: "1080p",
};

function shot(overrides: Partial<Shot>): Shot {
  return {
    id: "shot_0",
    index: 0,
    durationSec: 10,
    prompt: "保持连续性",
    characterIds: [],
    route: "t2v",
    continuity: "hard_cut",
    generateAudio: false,
    ...overrides,
  };
}

describe("shot router", () => {
  it("maps T2V to text_to_video with the job's model", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({ characterIds: ["char_main"], locationId: "loc_cinema" }),
      bible,
      resolveAsset,
      model: "kling-2.6",
      caps,
      aspectRatio: "16:9",
      resolution: "720p",
    });
    const call = mapToGrokRest(request);
    expect(request).toMatchObject({
      jobId: "job_harness-shot-0",
      mode: "text_to_video",
      model: "kling-2.6",
      durationSec: 10,
    });
    expect(call.path).toBe("/videos/generations");
    expect(call.body).toMatchObject({ duration: 10, aspect_ratio: "16:9", resolution: "720p" });
  });

  it("maps I2V and resolves the extracted start frame", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({
        route: "i2v",
        continuity: "tail_chain",
        startFrame: { source: "extracted", assetId: "shots/0/link.jpg" },
      }),
      bible,
      resolveAsset,
      model: "kling-2.6",
      caps,
    });
    const call = mapToGrokRest(request);
    expect(request.mode).toBe("image_to_video");
    expect(request.startImage).toEqual({
      kind: "data_uri",
      dataUri: "data:image/jpeg;base64,shots/0/link.jpg",
    });
    expect(call.path).toBe("/videos/generations");
    expect(call.body.image).toEqual({ url: "data:image/jpeg;base64,shots/0/link.jpg" });
  });

  it("maps R2V from character sheets and location references", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({ route: "r2v", characterIds: ["char_main"], locationId: "loc_cinema" }),
      bible,
      resolveAsset,
      model: "minimax-H3 参考",
      caps,
    });
    const call = mapToGrokRest(request);
    expect(request.mode).toBe("reference_to_video");
    expect(request.referenceImages).toHaveLength(2);
    expect(call.path).toBe("/videos/generations");
    expect(call.body.reference_images).toEqual([
      { url: "data:image/jpeg;base64,inputs/sheets/character-0.jpg" },
      { url: "data:image/jpeg;base64,inputs/locations/cinema.jpg" },
    ]);
  });

  it("truncates reference images to the provider cap, character sheets first", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({ route: "r2v", characterIds: ["char_main"], locationId: "loc_cinema" }),
      bible,
      resolveAsset,
      model: "kling-2.6",
      caps: { ...caps, maxReferenceImages: 1 },
    });
    expect(request.referenceImages).toEqual([
      { kind: "data_uri", dataUri: "data:image/jpeg;base64,inputs/sheets/character-0.jpg" },
    ]);
  });

  it("rejects a duration the provider does not carry", () => {
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ durationSec: 10 }),
        bible,
        resolveAsset,
        model: "kling-2.6",
        caps: { ...caps, durations: [5] },
      }),
    ).toThrow("当前 provider 不支持该时长档");
  });

  it("rejects missing continuity assets", () => {
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "i2v" }),
        bible,
        resolveAsset,
        model: "kling-2.6",
        caps,
      }),
    ).toThrow("I2V 需要 startFrame");
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "r2v", characterIds: [] }),
        bible: { ...bible, locations: [] },
        resolveAsset,
        model: "minimax-H3 参考",
        caps,
      }),
    ).toThrow("R2V 缺少参考资产");
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "t2v", continuity: "tail_chain" }),
        bible,
        resolveAsset,
        model: "kling-2.6",
        caps,
      }),
    ).toThrow("tail-chain 必须使用 I2V");
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "r2v", characterIds: ["char_main"] }),
        bible,
        resolveAsset,
        model: "kling-2.6",
        caps: { ...caps, maxReferenceImages: 0 },
      }),
    ).toThrow("当前 provider 不收参考图");
  });
});
