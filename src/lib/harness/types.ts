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

export type Continuity = "hard_cut" | "tail_chain" | "extend";

export type ProviderRouteHint =
  | "grok_t2v"
  | "grok_i2v"
  | "grok_r2v"
  | "grok_extend"
  | "jimeng_first_last";

export type FrameRef = {
  source: "user" | "generated" | "extracted";
  assetId: string;
};

export type Shot = {
  id: string;
  index: number;
  durationSec: number;
  prompt: string;
  characterIds: string[];
  locationId?: string;
  startFrame?: FrameRef;
  endFrame?: FrameRef;
  route: ProviderRouteHint;
  continuity: Continuity;
  generateAudio: boolean;
};

export type HarnessPlan = {
  targetDurationSec: 30 | 45 | 60;
  packing: { clips: Array<{ kind: "generate" | "extend"; durationSec: number }> };
  bible: IdentityBible;
  shots: Shot[];
  stitch: { transition: "hard_cut"; settleLastFrame: boolean };
};
