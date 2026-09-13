import type { DirectorInput } from "./director";
import { directorPlanSchema } from "./director";
import { packHarnessDuration } from "./pack-duration";
import type { HarnessPlan, Shot } from "./types";

/**
 * Deterministic Director for mock mode (no upstream key).
 * Generate-only packing in 10s clips (5s tail when needed), chained with tail-chain
 * I2V, so the whole pipeline — keyframe extraction, per-shot QC, stitch — runs offline.
 * 路由是供应商无关的 t2v/i2v，任何声明这两条 mode 的 provider 都能接。
 */
export function mockDirectorPlan(input: DirectorInput): HarnessPlan {
  const target = input.targetDurationSec;
  const clipLengths = packHarnessDuration(target).map((clip) => clip.durationSec as Shot["durationSec"]);
  const prompt = input.prompt.trim();
  const beats = ["建立镜头，交代空间与光线", "推进，主体动作展开", "变化，环境与情绪转折", "收束，回到主体定格"];
  const shots: Shot[] = clipLengths.map((durationSec, index) => {
    const beat = beats[Math.min(index, beats.length - 1)]!;
    const first = index === 0;
    const useStart = first && Boolean(input.hasStartFrame);
    return {
      id: `shot_${index}`,
      index,
      durationSec,
      prompt: `${prompt}\n镜头 ${index + 1}/${clipLengths.length}：${beat}。`,
      characterIds: ["c_main"],
      locationId: "loc_main",
      route: first && !useStart ? "t2v" : "i2v",
      continuity: first ? "hard_cut" : "tail_chain",
      generateAudio: true,
      ...(useStart ? { startFrame: { source: "user" as const, assetId: "inputs/start.jpg" } } : {}),
    };
  });
  const plan: HarnessPlan = {
    targetDurationSec: target,
    packing: { clips: clipLengths.map((durationSec) => ({ kind: "generate", durationSec })) },
    bible: {
      version: 1,
      logline: prompt.slice(0, 200) || "mock",
      style: {
        palette: ["纸白", "钴蓝", "赭红"],
        lighting: "与首镜一致的主光方向与色温",
        lens: "35mm 定焦，缓慢推轨",
        era: "当代",
        doNotChange: ["主体身份", "服装", "光线方向"],
      },
      characters: [
        {
          id: "c_main",
          name: "主体",
          lockedTraits: ["与提示词描述一致的外观", "服装与配色不变"],
          sheetAssetIds: [],
        },
      ],
      locations: [{ id: "loc_main", name: "主场景", refAssetIds: [] }],
      props: [],
    },
    shots,
    stitch: { transition: "hard_cut", settleLastFrame: Boolean(input.hasLastFrame) },
  };
  return directorPlanSchema.parse(plan) as HarnessPlan;
}
