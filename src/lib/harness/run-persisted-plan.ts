import { readJob } from "@/lib/jobs/store";
import {
  executeShotPlan,
  type ShotDependencyResolver,
} from "./shot-coordinator";
import {
  runPersistedShot,
  type PersistedShotOptions,
} from "./run-persisted-shot";
import { recoverPersistedShots, writeHarnessShot } from "./state";
import type { HarnessShotRecord } from "./shot-state";
import type { MediaRef, VideoProvider } from "@/lib/providers/types";
import type { JobRecord } from "@/lib/jobs/schema";
import type { Shot } from "./types";

export type PersistedPlanOptions = Omit<PersistedShotOptions, "sourceVideo" | "onState"> & {
  maxParallel: number;
  provider?: VideoProvider;
  sourceVideoFor?: (
    shot: Shot,
    record: HarnessShotRecord,
  ) => MediaRef | undefined | Promise<MediaRef | undefined>;
  dependencies?: ShotDependencyResolver;
  onState?: (record: HarnessShotRecord) => Promise<void> | void;
  /** Runs once a shot's dependencies succeeded, before it is (re)submitted, e.g. tail-frame extraction. */
  beforeShot?: (shot: Shot, record: HarnessShotRecord) => Promise<void> | void;
};

export async function runPersistedPlan(
  jobId: string,
  options: PersistedPlanOptions,
): Promise<JobRecord> {
  await recoverPersistedShots(jobId);
  const initial = await readJob(jobId);
  if (!initial) throw new Error("job not found");
  if (!initial.harnessPlan || !initial.harnessShots) {
    throw new Error("Harness 状态不存在");
  }

  const {
    maxParallel,
    sourceVideoFor,
    dependencies,
    onState,
    beforeShot,
    ...shotOptions
  } = options;
  await executeShotPlan({
    shots: initial.harnessPlan.shots,
    records: initial.harnessShots,
    maxParallel,
    dependencies,
    onState: async (next) => {
      await writeHarnessShot(jobId, next);
      await onState?.(next);
    },
    execute: async (shot, record) => {
      await beforeShot?.(shot, record);
      const sourceVideo = await sourceVideoFor?.(shot, record);
      await runPersistedShot(jobId, shot.id, {
        ...shotOptions,
        sourceVideo,
        recover: false,
        onState,
      });
      const current = await readJob(jobId);
      if (!current) throw new Error("job not found");
      const next = current.harnessShots?.find((item) => item.id === shot.id);
      if (!next) throw new Error("shot 状态不存在");
      return next;
    },
  });

  const final = await readJob(jobId);
  if (!final) throw new Error("job not found");
  return final;
}
