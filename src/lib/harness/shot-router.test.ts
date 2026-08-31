import { describe, expect, it } from "vitest";
import { mapToGrokRest } from "@/lib/providers/grok/rest-map";
import type { IdentityBible, Shot } from "./types";
import { buildShotRequest } from "./shot-router";

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

function shot(overrides: Partial<Shot>): Shot {
  return {
    id: "shot_0",
    index: 0,
    durationSec: 8,
    prompt: "保持连续性",
    characterIds: [],
    route: "grok_t2v",
    continuity: "hard_cut",
    generateAudio: false,
    ...overrides,
  };
}

describe("shot router", () => {
  it("maps T2V to the 1.5 generation endpoint", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({ durationSec: 12, characterIds: ["char_main"], locationId: "loc_cinema" }),
      bible,
      resolveAsset,
      aspectRatio: "16:9",
      resolution: "720p",
    });
    const call = mapToGrokRest(request);
    expect(request).toMatchObject({
      jobId: "job_harness-shot-0",
      mode: "text_to_video",
      model: "grok-imagine-video-1.5",
      durationSec: 12,
    });
    expect(call.path).toBe("/videos/generations");
    expect(call.body).toMatchObject({ duration: 12, aspect_ratio: "16:9", resolution: "720p" });
  });

  it("maps I2V and resolves the extracted start frame", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({
        route: "grok_i2v",
        continuity: "tail_chain",
        startFrame: { source: "extracted", assetId: "shots/0/link.jpg" },
      }),
      bible,
      resolveAsset,
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
      shot: shot({ route: "grok_r2v", characterIds: ["char_main"], locationId: "loc_cinema" }),
      bible,
      resolveAsset,
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

  it("maps Extend to model 1.0 and requires a Files file_id", () => {
    const request = buildShotRequest({
      jobId: "job_harness",
      shot: shot({ route: "grok_extend", continuity: "extend", durationSec: 10 }),
      bible,
      resolveAsset,
      sourceVideo: { kind: "file_id", fileId: "file-previous-shot" },
    });
    const call = mapToGrokRest(request);
    expect(request).toMatchObject({ mode: "extend_video", model: "grok-imagine-video", durationSec: 10 });
    expect(request.aspectRatio).toBeUndefined();
    expect(request.resolution).toBeUndefined();
    expect(call.path).toBe("/videos/extensions");
    expect(call.body.video).toEqual({ file_id: "file-previous-shot" });
  });

  it("rejects missing continuity assets and disabled Jimeng routing", () => {
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "grok_i2v" }),
        bible,
        resolveAsset,
      }),
    ).toThrow("I2V 需要 startFrame");
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "grok_r2v", characterIds: [] }),
        bible: { ...bible, locations: [] },
        resolveAsset,
      }),
    ).toThrow("R2V 缺少参考资产");
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "grok_extend", continuity: "extend", durationSec: 8 }),
        bible,
        resolveAsset,
        sourceVideo: { kind: "path", path: "previous.mp4" },
      }),
    ).toThrow("Extend 必须使用 file_id");
    expect(() =>
      buildShotRequest({
        jobId: "job_harness",
        shot: shot({ route: "jimeng_first_last" }),
        bible,
        resolveAsset,
      }),
    ).toThrow("Jimeng 尚未启用");
  });
});
