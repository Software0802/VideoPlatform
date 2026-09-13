export type HarnessJobStatus =
  | "directing"
  | "keyframing"
  | "generating_shots"
  | "qc"
  | "stitching"
  | "awaiting_approval";

export type IdentityBible = {
  version: 1;
  logline: string;
  style: {
    palette: string[];
    lighting: string;
    lens: string;
    era: string;
    doNotChange: string[];
  };
  characters: Array<{
    id: string;
    name: string;
    lockedTraits: string[];
    sheetAssetIds: string[];
    voiceId?: string;
  }>;
  locations: Array<{ id: string; name: string; refAssetIds: string[] }>;
  props: Array<{ id: string; name: string; refAssetIds: string[] }>;
};

export type Continuity = "hard_cut" | "tail_chain";

/** 供应商无关的 shot 路由；具体映射到哪条原生 mode 由 shot-router 按 provider 能力定。 */
export type ShotRoute = "t2v" | "i2v" | "r2v";

/** 上游一次生成本身交付的时长档；续接靠尾帧→i2v，不再有 extend。 */
export type ShotDuration = 5 | 10;

export type FrameRef = {
  source: "user" | "generated" | "extracted";
  assetId: string;
};

export type Shot = {
  id: string;
  index: number;
  durationSec: ShotDuration;
  prompt: string;
  characterIds: string[];
  locationId?: string;
  startFrame?: FrameRef;
  endFrame?: FrameRef;
  route: ShotRoute;
  continuity: Continuity;
  generateAudio: boolean;
};

export type HarnessPlan = {
  targetDurationSec: 30 | 45 | 60;
  packing: { clips: Array<{ kind: "generate"; durationSec: ShotDuration }> };
  bible: IdentityBible;
  shots: Shot[];
  stitch: { transition: "hard_cut"; settleLastFrame: boolean };
};
