export type ScenePhase = "idle" | "working" | "done" | "error";

export type SceneProgress = {
  phase: ScenePhase;
  progress: number;
};

export type SceneSkinId = string;
