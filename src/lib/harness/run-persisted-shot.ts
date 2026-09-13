import { readJob } from "@/lib/jobs/store";
import { modelForProvider } from "@/lib/jobs/provider-settings";
import { productById } from "@/lib/products/catalog";
import { relayMaxSwitches } from "@/lib/env";
import { recordOutcome } from "@/lib/providers/health";
import { currentProviderId, providerForId } from "@/lib/providers/router";
import {
  executeShotWithRetries,
  type ShotExecutorOptions,
  type ShotSubmitContext,
} from "./shot-executor";
import { downgradeR2vShot, type ShotModels } from "./shot-router";
import { recoverPersistedShot, writeHarnessShot } from "./state";
import type { HarnessShotRecord } from "./shot-state";
import type { JobRecord } from "@/lib/jobs/schema";

export type PersistedShotOptions = Omit<
  ShotExecutorOptions,
  "jobId" | "shot" | "bible" | "record" | "provider" | "onState" | "isCanceled" | "models" | "onCertainRejection"
> & {
  provider?: ShotExecutorOptions["provider"];
  isCanceled?: () => Promise<boolean>;
  onState?: (record: HarnessShotRecord) => Promise<void> | void;
  onCertainRejection?: ShotExecutorOptions["onCertainRejection"];
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

  // 续跑按这面镜子的实际落点（record.provider，换家后由 executor 写回）解析 provider，
  // 不是 job.provider——后者还是建任务时的家。
  const provider = rest.provider ?? providerForId(record.provider ?? initial.provider);
  // shot 按各自的原生 mode 取模型：YMan 这类 provider 的 t2v / i2v / r2v 是不同模型，
  // job.model 只是建任务时定的 t2v 模型，共用会把「不收参考图」的模型名发给 i2v shot。
  const product = initial.product ? productById(initial.product) : null;
  const models = modelsFor(provider.id, product);
  // 换过家的 r2v 镜重启续跑时降级要重放（record 只记 provider/exclusions，不记降级后的 shot）。
  const resumedShot =
    shot.route === "r2v" && !provider.capabilities().modes.includes("reference_to_video")
      ? downgradeR2vShot(shot)
      : shot;
  const isCanceled = rest.isCanceled ?? (async () => {
    const current = await readJob(jobId);
    return !current || current.status === "canceled" || Boolean(current.canceled);
  });

  /**
   * 分镜级换家（N3.4）：单镜提交被**确定拒绝**时换到下一家，已成功的镜不动。
   * - 排除集 = 本镜已试过的全部家（随 record.excludedProviders 落盘，跨重试延续）；
   * - 上限 `RELAY_MAX_SWITCHES` 按镜计；
   * - r2v 镜落到不声明 r2v 的家时按 lockPlan 同规则降级 i2v/t2v；
   * - 模糊失败（读超时 / 断连 / 裸 5xx）不会走到这里——executor 判 uncertain_submit。
   */
  const onCertainRejection =
    rest.onCertainRejection ??
    (async (error, _record, ctx): Promise<ShotSubmitContext | null> => {
      const switches = ctx.excluded.length;
      if (switches >= relayMaxSwitches()) return null;
      recordOutcome(ctx.provider.id, "video", false, 0, error.code, {
        retryAfterMs: error.retryAfterMs,
      });
      const excluded = [...new Set([...ctx.excluded, ctx.provider.id])];
      let nextId: string;
      try {
        nextId = currentProviderId("image_to_video", {
          harness: true,
          aspectRatio: rest.aspectRatio ?? initial.aspectRatio ?? undefined,
          resolution: rest.resolution ?? initial.resolution ?? undefined,
          exclude: excluded,
        });
      } catch {
        return null; // 没有下一家接得下了：照原失败路径走（重试预算 / needs_review）
      }
      const nextProvider = providerForId(nextId);
      let nextShot = ctx.shot;
      if (nextShot.route === "r2v" && !nextProvider.capabilities().modes.includes("reference_to_video")) {
        nextShot = downgradeR2vShot(nextShot);
      }
      return {
        provider: nextProvider,
        models: modelsFor(nextId, product),
        shot: nextShot,
        excluded,
      };
    });

  await executeShotWithRetries({
    ...rest,
    jobId,
    shot: resumedShot,
    bible: initial.harnessPlan.bible,
    record,
    provider,
    models,
    isCanceled,
    onCertainRejection,
    onState: async (next) => {
      await writeHarnessShot(jobId, next);
      await rest.onState?.(next);
    },
  });

  const final = await readJob(jobId);
  if (!final) throw new Error("job not found");
  return final;
}

function modelsFor(providerId: string, product: ReturnType<typeof productById> | null): ShotModels {
  // 产品是 provider 绑定的：换家之后沿用旧家的产品去查模型会把别家的名字发给它。
  const pinned = product && product.provider === providerId ? product : undefined;
  return {
    text_to_video: modelForProvider(providerId, "text_to_video", pinned),
    image_to_video: modelForProvider(providerId, "image_to_video", pinned),
    reference_to_video: modelForProvider(providerId, "reference_to_video", pinned),
  };
}
