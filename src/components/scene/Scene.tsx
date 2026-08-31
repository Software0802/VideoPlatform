"use client";

import { SceneHost } from "./SceneHost";
import type { SceneProgress } from "@/types/scene";

/**
 * Compatibility entry point for callers that still import `scene/Scene`.
 * The actual skin is owned by SceneHost; keeping this adapter free of shell,
 * studio, and job imports preserves the replaceable-scene boundary.
 */
export type ReelItem = {
  id: string;
  kind: "video" | "image";
  src: string;
  prompt: string;
};

const IDLE_PROGRESS: SceneProgress = { phase: "idle", progress: 0 };

export function Scene({
  progress = IDLE_PROGRESS,
}: {
  /** Legacy props are accepted by the type surface but no longer drive the skin. */
  reels?: ReelItem[];
  mock?: boolean;
  upstream?: "mock" | "xai" | "sub2api";
  progress?: SceneProgress;
}) {
  return <SceneHost progress={progress} />;
}
