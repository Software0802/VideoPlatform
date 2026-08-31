import type { HarnessPlan, Shot } from "./types";

export type KeyframeAssignments = {
  userStartAssetId?: string;
  userLastAssetId?: string;
  /** Keys are the preceding shot indexes, e.g. "0" links shot 0 to shot 1. */
  extractedTailFrames?: Readonly<Record<string, string>>;
};

export function applyKeyframeLocks(
  plan: HarnessPlan,
  assignments: KeyframeAssignments = {},
): HarnessPlan {
  if (!plan.shots.length) throw new Error("计划缺少镜头");
  const userStart = validAssetId(assignments.userStartAssetId);
  const userLast = validAssetId(assignments.userLastAssetId);
  const extracted = assignments.extractedTailFrames ?? {};

  const shots = plan.shots.map((shot) => {
    const next: Shot = { ...shot };
    if (shot.continuity === "tail_chain") {
      if (shot.index === 0) {
        if (!shot.startFrame) throw new Error("tail-chain 第一镜无前置帧");
      } else if (shot.startFrame?.source !== "user") {
        const assetId = validAssetId(extracted[String(shot.index - 1)]);
        if (!assetId) throw new Error("缺少 tail-chain 抽取帧");
        next.startFrame = { source: "extracted", assetId };
      }
    }
    if (shot.index === 0 && userStart) {
      next.startFrame = { source: "user", assetId: userStart };
    }
    if (shot.index === plan.shots.length - 1 && userLast) {
      next.endFrame = { source: "user", assetId: userLast };
    }
    return next;
  });

  return { ...plan, shots };
}

function validAssetId(assetId: string | undefined): string | undefined {
  if (assetId === undefined) return undefined;
  if (typeof assetId !== "string" || !assetId.trim()) throw new Error("帧资产无效");
  return assetId;
}
