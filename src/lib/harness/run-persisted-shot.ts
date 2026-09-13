import { readJob } from "@/lib/jobs/store";
import { modelForProvider } from "@/lib/jobs/provider-settings";
import { productById } from "@/lib/products/catalog";
import { providerForId } from "@/lib/providers/router";
import {
  executeShotWithRetries,
  type ShotExecutorOptions,
} from "./shot-executor";
import type { ShotModels } from "./shot-router";
import { recoverPersistedShot, writeHarnessShot } from "./state";
import type { HarnessShotRecord } from "./shot-state";
import type { JobRecord } from "@/lib/jobs/schema";

export type PersistedShotOptions = Omit<
  ShotExecutorOptions,
  "jobId" | "shot" | "bible" | "record" | "provider" | "onState" | "isCanceled" | "models"
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
  // shot 按各自的原生 mode 取模型：YMan 这类 provider 的 t2v / i2v / r2v 是不同模型，
  // job.model 只是建任务时定的 t2v 模型，共用会把「不收参考图」的模型名发给 i2v shot。
  const product = initial.product ? productById(initial.product) : null;
  const models: ShotModels = {
    text_to_video: modelForProvider(provider.id, "text_to_video", product),
    image_to_video: modelForProvider(provider.id, "image_to_video", product),
    reference_to_video: modelForProvider(provider.id, "reference_to_video", product),
  };
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
    models,
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
