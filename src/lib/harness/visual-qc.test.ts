import { describe, expect, it, vi } from "vitest";
import {
  buildVisualQcRequest,
  parseVisualQcResponse,
  scoreVisualConsistency,
  tightenShotPrompt,
} from "./visual-qc";
import type { IdentityBible, Shot } from "./types";

const bible: IdentityBible = {
  version: 1,
  logline: "雨夜的外滩",
  style: {
    palette: ["深青", "钠灯橙"],
    lighting: "路灯逆光",
    lens: "35mm",
    era: "当代",
    doNotChange: ["风衣颜色"],
  },
  characters: [
    { id: "c1", name: "女主", lockedTraits: ["深青色风衣", "齐肩黑发"], sheetAssetIds: [] },
  ],
  locations: [],
  props: [],
};

const shot: Shot = {
  id: "shot_1",
  index: 1,
  durationSec: 15,
  prompt: "她沿江边走远",
  characterIds: ["c1"],
  route: "grok_i2v",
  continuity: "tail_chain",
  startFrame: { source: "extracted", assetId: "shots/0/tail.jpg" },
  generateAudio: true,
};

describe("visual qc", () => {
  it("builds a vision request with references before frames and a strict schema", () => {
    const request = buildVisualQcRequest({
      bible,
      shot,
      references: [{ label: "上一镜尾帧", dataUri: "data:image/jpeg;base64,ref" }],
      frames: [{ label: "首帧", dataUri: "data:image/jpeg;base64,first" }],
    });
    expect(request.model).toBe("grok-4.6");
    expect(request.responseFormat.json_schema.strict).toBe(true);
    const content = request.messages[1]!.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]!.text).toContain("女主：深青色风衣");
    expect(parts.filter((p) => p.type === "image_url").map((p) => p.image_url!.url)).toEqual([
      "data:image/jpeg;base64,ref",
      "data:image/jpeg;base64,first",
    ]);
  });

  it("parses scores, averages them, and rejects out-of-range values", async () => {
    const raw = JSON.stringify({
      face: 0.9,
      hair: 0.8,
      wardrobe: 1,
      lighting: 0.7,
      palette: 0.6,
      notes: "ok",
    });
    expect(parseVisualQcResponse(raw).overall).toBe(0.8);
    expect(() => parseVisualQcResponse(JSON.stringify({ face: 2 }))).toThrow();

    const complete = vi.fn(async () => raw);
    const score = await scoreVisualConsistency({ bible, shot, references: [], frames: [] }, { complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(score.face).toBe(0.9);
  });

  it("tightens the prompt only on retries", () => {
    expect(tightenShotPrompt(shot, bible, 0)).toBe(shot.prompt);
    const tightened = tightenShotPrompt(shot, bible, 1);
    expect(tightened.startsWith(shot.prompt)).toBe(true);
    expect(tightened).toContain("风衣颜色");
    expect(tightened).toContain("女主深青色风衣");
    expect(tightened.length).toBeLessThanOrEqual(2000);
  });
});
