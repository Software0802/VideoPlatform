import type { JobPublic } from "@/lib/jobs/schema";
import type { NativeMode } from "@/lib/providers/types";
import type { MessageKey } from "@/lib/i18n/messages";

/**
 * 任务模式的展示名与纯状态判定。多语言之后这里只存**键名**，取文案是调用方的事
 * （`const t = useT(); t(MODE_LABEL[job.mode])`）——这个模块被客户端组件 import，
 * 不能自己持有语言状态。
 *
 * 换壳之后这里只剩真正还有人用的东西：进度条 / 状态徽标那几套表随原型一起被
 * `CreateView` 的「阶段」文案取代了（`create.stage.*`），留着的话字典里也会跟着留下
 * 一批永远翻译不到的键。
 */
export const MODE_LABEL: Record<NativeMode, MessageKey> = {
  text_to_image: "create.mode.text_to_image",
  text_to_video: "create.mode.text_to_video",
  image_to_video: "create.mode.image_to_video",
  reference_to_video: "create.mode.reference_to_video",
  edit_video: "create.mode.edit_video",
  extend_video: "create.mode.extend_video",
};

const TERMINAL: ReadonlySet<JobPublic["status"]> = new Set(["succeeded", "failed", "expired", "canceled"]);
const FAILED: ReadonlySet<JobPublic["status"]> = new Set(["failed", "expired", "canceled"]);

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

