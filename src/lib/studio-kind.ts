import type { NativeMode } from "@/lib/providers/types";

export const STUDIO_KINDS = ["image", "video", "audio"] as const;
export type StudioKind = (typeof STUDIO_KINDS)[number];

export function isStudioKind(value: string): value is StudioKind {
  return (STUDIO_KINDS as readonly string[]).includes(value);
}

export function defaultsForKind(kind: StudioKind): {
  mode: NativeMode;
  generateAudio: boolean;
} {
  if (kind === "image") return { mode: "text_to_image", generateAudio: false };
  return { mode: "text_to_video", generateAudio: true };
}

export function kindTitle(kind: StudioKind): string {
  if (kind === "image") return "图像工作室";
  if (kind === "audio") return "音频工作室";
  return "视频工作室";
}

export function studioPath(kind: StudioKind, prompt = ""): string {
  const trimmed = prompt.trim();
  if (!trimmed) return `/studio/${kind}`;
  return `/studio/${kind}?prompt=${encodeURIComponent(trimmed)}`;
}
