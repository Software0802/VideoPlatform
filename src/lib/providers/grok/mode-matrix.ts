import type { NativeMode } from "@/lib/providers/types";

export const MODEL_1_5 = "grok-imagine-video-1.5";
export const MODEL_1_0 = "grok-imagine-video";
export const MODEL_IMAGE = "grok-imagine-image-2.0";

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const IMAGE_RESOLUTIONS = ["1k", "2k"] as const;

export const HARNESS_DURATIONS = [30, 45, 60] as const;

export function isImageMode(mode: NativeMode): boolean {
  return mode === "text_to_image";
}

export function modelForMode(mode: NativeMode): string {
  if (isImageMode(mode)) return MODEL_IMAGE;
  if (mode === "edit_video" || mode === "extend_video") return MODEL_1_0;
  return MODEL_1_5;
}

export function endpointForMode(mode: NativeMode): string {
  if (mode === "text_to_image") return "/images/generations";
  if (mode === "edit_video") return "/videos/edits";
  if (mode === "extend_video") return "/videos/extensions";
  return "/videos/generations";
}

export const PRESET_VOICES = ["eve", "leo", "ara", "rex"] as const;
