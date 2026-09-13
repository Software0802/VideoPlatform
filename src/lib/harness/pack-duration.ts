/** Pure helper for Phase 2. JobRunner must not import this to stitch. */
import type { HarnessClip } from "@/lib/cost";

/**
 * 供应商无关的打包：上游一次生成本身交付 5 / 10 秒档（可灵只收这两档，YMan
 * 另有 15 秒档但通用 harness 类型只取 5/10），更长的一致性靠 tail_chain → i2v
 * 续接，不再有 extend 片段。
 */
export function packHarnessDuration(targetSec: 30 | 45 | 60): HarnessClip[] {
  const lengths =
    targetSec === 30
      ? [10, 10, 10]
      : targetSec === 45
        ? [10, 10, 10, 10, 5]
        : [10, 10, 10, 10, 10, 10];
  return lengths.map((durationSec) => ({ kind: "generate" as const, durationSec: durationSec as 5 | 10 }));
}
