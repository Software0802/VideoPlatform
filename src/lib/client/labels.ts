import type { JobPublic } from "@/lib/jobs/schema";
import type { NativeMode } from "@/lib/providers/types";

export const MODES: { id: NativeMode; label: string; hint: string }[] = [
  { id: "text_to_image", label: "文生图", hint: "一张静帧，立刻出" },
  { id: "text_to_video", label: "文生视频", hint: "只写提示词" },
  { id: "image_to_video", label: "图生视频", hint: "首帧图 = 起始画面" },
  { id: "reference_to_video", label: "参考生视频", hint: "最多 7 张参考，不锁第一帧" },
  { id: "edit_video", label: "编辑视频", hint: "改已有片子，源片 8.7 秒以内" },
  { id: "extend_video", label: "延长视频", hint: "从末帧接着演，延长 2 到 10 秒" },
];

export const MODE_LABEL: Record<NativeMode, string> = Object.fromEntries(
  MODES.map((m) => [m.id, m.label]),
) as Record<NativeMode, string>;

export const STATUS_LABEL: Record<JobPublic["status"], string> = {
  queued: "排队中",
  submitting: "提交 Grok",
  pending: "生成中",
  persisting: "落盘",
  directing: "导演分镜",
  keyframing: "锁帧",
  generating_shots: "生成分镜",
  qc: "质检",
  stitching: "拼接",
  succeeded: "完成",
  failed: "失败",
  expired: "已过期",
  canceled: "已取消",
};

export const STAGES = ["排队", "提交", "生成", "落盘", "完成"] as const;

export function stageIndex(s: JobPublic["status"]): number {
  switch (s) {
    case "queued":
      return 0;
    case "submitting":
    case "directing":
    case "keyframing":
      return 1;
    case "pending":
    case "generating_shots":
    case "qc":
      return 2;
    case "persisting":
    case "stitching":
      return 3;
    case "succeeded":
      return 4;
    default:
      return -1;
  }
}

export const TERMINAL: ReadonlySet<JobPublic["status"]> = new Set(["succeeded", "failed", "expired", "canceled"]);
export const FAILED: ReadonlySet<JobPublic["status"]> = new Set(["failed", "expired", "canceled"]);

export function isTerminal(status: JobPublic["status"]) {
  return TERMINAL.has(status);
}

export function isFailed(status: JobPublic["status"]) {
  return FAILED.has(status);
}

export function isActive(status: JobPublic["status"]) {
  return !TERMINAL.has(status);
}

export function formatElapsed(from: string, now: number | null): string {
  if (now == null) return "00:00";
  const sec = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function aspectStyle(aspect: JobPublic["aspectRatio"]): { aspectRatio: string; portrait: boolean } {
  const value = aspect ?? "16:9";
  const [w, h] = value.split(":").map(Number);
  return { aspectRatio: `${w} / ${h}`, portrait: h > w };
}
