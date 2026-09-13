/** 画布视图的共享小工具（R5.3 拆分：NodeCard / ConflictDialog / useCanvasPolling 共用）。 */

export function clamp(min: number, v: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/* 月-日 时:分（与 CreateView 同款）：纯数字两种语言读法一致，不进字典。 */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired"]);
