import { readJob } from "@/lib/jobs/store";
import { providerForId } from "@/lib/providers/router";
import {
  executeShotWithRetries,
  type ShotExecutorOptions,
} from "./shot-executor";
import { recoverPersistedShot, writeHarnessShot } from "./state";
import type { HarnessShotRecord } from "./shot-state";
import type { JobRecord } from "@/lib/jobs/schema";

export type PersistedShotOptions = Omit<
  ShotExecutorOptions,
  "jobId" | "shot" | "bible" | "record" | "provider" | "onState" | "isCanceled"
> & {
  provider?: ShotExecutorOptions["provider"];
  isCanceled?: () => Promise<boolean>;
  onState?: (record: HarnessShotRecord) => Promise<void> | void;
  recover?: boolean;
};

export async function runPersistedShot(
  jobId: string,
  shotId: string,
  options: PersistedShotOptions,
): Promise<JobRecord> {
  const { recover = true, ...rest } = options;
  if (recover) await recoverPersistedShot(jobId, shotId);
  const initial = await readJob(jobId);
  if (!initial) throw new Error("job not found");
  if (!initial.harnessPlan || !initial.harnessShots) {
    throw new Error("Harness 状态不存在");
  }
  const shot = initial.harnessPlan.shots.find((item) => item.id === shotId);
  const record = initial.harnessShots.find((item) => item.id === shotId);
  if (!shot || !record) throw new Error("shot 不存在");

  const provider = rest.provider ?? providerForId(initial.provider);
  const isCanceled = rest.isCanceled ?? (async () => {
    const current = await readJob(jobId);
    return !current || current.status === "canceled" || Boolean(current.canceled);
  });

  await executeShotWithRetries({
    ...rest,
    jobId,
    shot,
    bible: initial.harnessPlan.bible,
    record,
    provider,
    model: initial.model,
    isCanceled,
    onState: async (next) => {
      await writeHarnessShot(jobId, next);
      await rest.onState?.(next);
    },
  });

  const final = await readJob(jobId);
  if (!final) throw new Error("job not found");
  return final;
}
