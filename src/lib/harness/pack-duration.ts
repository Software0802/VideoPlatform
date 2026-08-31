/** Pure helper for Phase 2. JobRunner must not import this to stitch. */
import type { HarnessClip } from "@/lib/cost";

export function packDuration(totalSec: number): number[] {
  const clamped = Math.max(4, Math.min(120, Math.round(totalSec)));
  const target = 8;
  let count = Math.max(1, Math.round(clamped / target));
  while (clamped / count > 12) count += 1;
  while (count > 1 && clamped / count < 4) count -= 1;
  const base = Math.floor(clamped / count);
  const rem = clamped - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}

export function packHarnessDuration(targetSec: 30 | 45 | 60): HarnessClip[] {
  if (targetSec === 30) {
    return [
      { kind: "generate", durationSec: 15 },
      { kind: "extend", durationSec: 10 },
      { kind: "generate", durationSec: 5 },
    ];
  }
  if (targetSec === 45) {
    return [
      { kind: "generate", durationSec: 15 },
      { kind: "extend", durationSec: 10 },
      { kind: "generate", durationSec: 15 },
      { kind: "extend", durationSec: 5 },
    ];
  }
  return [
    { kind: "generate", durationSec: 15 },
    { kind: "extend", durationSec: 10 },
    { kind: "generate", durationSec: 15 },
    { kind: "extend", durationSec: 10 },
    { kind: "generate", durationSec: 10 },
  ];
}
