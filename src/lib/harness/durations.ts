/** Harness 长片时长档（30/45/60 秒）。纯常量，客户端（ShellContext）也 import，不能带 node 依赖。 */
export const HARNESS_DURATIONS = [30, 45, 60] as const;
export type HarnessDuration = (typeof HARNESS_DURATIONS)[number];

export function isHarnessDuration(durationSec?: number): durationSec is HarnessDuration {
  return typeof durationSec === "number" && (HARNESS_DURATIONS as readonly number[]).includes(durationSec);
}
