import type { JobRecord } from "@/lib/jobs/schema";
import { updateJob } from "@/lib/jobs/store";
import { directorPlanSchema } from "./director";
import { recoverHarnessShot, recoverHarnessShots } from "./shot-recover";
import {
  createShotRecords,
  harnessShotRecordSchema,
  harnessShotStatusSchema,
  prepareShotRetry,
  transitionShot,
  type HarnessShotRecord,
  type HarnessShotStatus,
  type ShotPatch,
} from "./shot-state";
import type { HarnessPlan } from "./types";

export async function saveHarnessPlan(
  jobId: string,
  plan: HarnessPlan,
): Promise<JobRecord> {
  const validated = directorPlanSchema.parse(plan) as HarnessPlan;
  const initialShots = createShotRecords(validated.shots);
  return updateJob(jobId, (record) => {
    if (record.harnessPlan || record.harnessShots) {
      if (!record.harnessPlan || !record.harnessShots) {
        throw new Error("Harness 状态不完整");
      }
      if (JSON.stringify(record.harnessPlan) !== JSON.stringify(validated)) {
        throw new Error("Harness 计划已存在");
      }
      return record;
    }
    return {
      ...record,
      harnessPlan: validated,
      harnessShots: initialShots,
    };
  });
}

/** Patch the Identity Bible in place (e.g. sheet asset ids after keyframing); shots are untouched. */
export async function updateHarnessBible(
  jobId: string,
  fn: (bible: HarnessPlan["bible"]) => HarnessPlan["bible"],
): Promise<JobRecord> {
  return updateJob(jobId, (record) => {
    if (!record.harnessPlan || !record.harnessShots) {
      throw new Error("Harness 状态不存在");
    }
    const nextPlan = directorPlanSchema.parse({
      ...record.harnessPlan,
      bible: fn(record.harnessPlan.bible),
    }) as HarnessPlan;
    return { ...record, harnessPlan: nextPlan };
  });
}

export async function updateHarnessShot(
  jobId: string,
  shotId: string,
  to: HarnessShotStatus,
  patch: ShotPatch = {},
): Promise<JobRecord> {
  const nextStatus = harnessShotStatusSchema.parse(to);
  return updateJob(jobId, (record) => {
    if (!record.harnessPlan || !record.harnessShots) {
      throw new Error("Harness 状态不存在");
    }
    const index = record.harnessShots.findIndex((shot) => shot.id === shotId);
    if (index < 0) throw new Error("shot 不存在");
    const nextShot = transitionShot(record.harnessShots[index]!, nextStatus, patch);
    const harnessShots = record.harnessShots.map((shot, position) =>
      position === index ? nextShot : shot,
    );
    return { ...record, harnessShots };
  });
}

export async function retryHarnessShot(
  jobId: string,
  shotId: string,
  maxRetries = 2,
): Promise<JobRecord> {
  return updateJob(jobId, (record) => {
    if (!record.harnessPlan || !record.harnessShots) {
      throw new Error("Harness 状态不存在");
    }
    const index = record.harnessShots.findIndex((shot) => shot.id === shotId);
    if (index < 0) throw new Error("shot 不存在");
    const nextShot = prepareShotRetry(record.harnessShots[index]!, maxRetries);
    const harnessShots = record.harnessShots.map((shot, position) =>
      position === index ? nextShot : shot,
    );
    return { ...record, harnessShots };
  });
}

export async function writeHarnessShot(
  jobId: string,
  nextShot: HarnessShotRecord,
): Promise<JobRecord> {
  const parsed = harnessShotRecordSchema.parse(nextShot);
  return updateJob(jobId, (record) => {
    if (!record.harnessPlan || !record.harnessShots) {
      throw new Error("Harness 状态不存在");
    }
    const index = record.harnessShots.findIndex((shot) => shot.id === parsed.id);
    if (index < 0) throw new Error("shot 不存在");
    const harnessShots = record.harnessShots.map((shot, position) =>
      position === index ? parsed : shot,
    );
    return { ...record, harnessShots };
  });
}

export async function recoverPersistedShot(jobId: string, shotId: string): Promise<JobRecord> {
  return updateJob(jobId, (record) => {
    if (!record.harnessPlan || !record.harnessShots) {
      throw new Error("Harness 状态不存在");
    }
    const index = record.harnessShots.findIndex((shot) => shot.id === shotId);
    if (index < 0) throw new Error("shot 不存在");
    const nextShot = recoverHarnessShot(record.harnessShots[index]!);
    const harnessShots = record.harnessShots.map((shot, position) =>
      position === index ? nextShot : shot,
    );
    return { ...record, harnessShots };
  });
}

export async function recoverPersistedShots(jobId: string): Promise<JobRecord> {
  return updateJob(jobId, (record) => {
    if (!record.harnessPlan || !record.harnessShots) {
      throw new Error("Harness 状态不存在");
    }
    return { ...record, harnessShots: recoverHarnessShots(record.harnessShots) };
  });
}

export function harnessStateOf(record: JobRecord): {
  plan: HarnessPlan | null;
  shots: HarnessShotRecord[] | null;
} {
  return {
    plan: record.harnessPlan ?? null,
    shots: record.harnessShots ?? null,
  };
}
