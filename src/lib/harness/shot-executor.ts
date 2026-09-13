import { buildShotRequest, type BuildShotRequestInput, type ShotModels } from "./shot-router";
import { UNCERTAIN_SUBMIT_MESSAGE } from "./shot-recover";
import {
  isAmbiguousSubmitError,
  isCertainRejection,
} from "@/lib/providers/rejection";
import { recoverHarnessShot } from "./shot-recover";
import {
  canTransitionShot,
  prepareShotRetry,
  transitionShot,
  type HarnessShotRecord,
  type ShotPatch,
} from "./shot-state";
import type { IdentityBible, Shot } from "./types";
import {
  ProviderHttpError,
  type ProviderHandle,
  type ProviderPoll,
  type VideoProvider,
} from "@/lib/providers/types";

export type ShotOutputPersister = (
  shot: Shot,
  handle: ProviderHandle,
) => Promise<string | { outputPath: string; qc?: HarnessShotRecord["qc"] }>;

/**
 * 一条 shot 当前用谁提交。确定拒单换家（N3.4）会整体换掉 provider/models，必要时
 * 把 r2v 镜降级（`downgradeR2vShot`）；`excluded` 是这面镜子已经试过、确定被拒的
 * 全部家——它们不再进候选，也不进重试。
 */
export type ShotSubmitContext = {
  provider: VideoProvider;
  models: ShotModels;
  shot: Shot;
  excluded: string[];
};

export type ShotExecutorOptions = {
  jobId: string;
  shot: Shot;
  bible: IdentityBible;
  record: HarnessShotRecord;
  provider: VideoProvider;
  /** 各原生 mode 的模型名（按 mode 分模型的 provider 如 YMan 不能共用 job.model）。 */
  models: BuildShotRequestInput["models"];
  resolveAsset: BuildShotRequestInput["resolveAsset"];
  aspectRatio?: BuildShotRequestInput["aspectRatio"];
  resolution?: BuildShotRequestInput["resolution"];
  persistOutput: ShotOutputPersister;
  onState?: (record: HarnessShotRecord) => Promise<void> | void;
  isCanceled?: () => Promise<boolean>;
  cleanupHandle?: (handle: ProviderHandle) => Promise<void>;
  cleanupOutput?: (path: string) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Rewrite the shot per attempt (e.g. tighten the prompt after a QC rejection). */
  shotOverride?: (shot: Shot, record: HarnessShotRecord) => Shot;
  /**
   * Runs before every paid submit, including automatic retries (R06 budget gate).
   * Throw a ShotFailure with `terminal: true` to stop the shot without further attempts.
   */
  beforeAttempt?: (shot: Shot, record: HarnessShotRecord) => Promise<void> | void;
  /**
   * 提交被上游**确定拒绝**时调（只在 `provider.submit` 抛出、handle 还没拿到的窗口
   * 触发）：返回新的提交上下文就换门再试，返回 null 就走原失败路径。
   * 模糊失败（读超时 / 中途断连 / 裸 5xx）永远不会调到这里——可能已受理的请求
   * 绝不重发。
   */
  onCertainRejection?: (
    error: ProviderHttpError,
    record: HarnessShotRecord,
    ctx: ShotSubmitContext,
  ) => Promise<ShotSubmitContext | null>;
};

export async function executeShotWithRetries(
  options: ShotExecutorOptions,
): Promise<HarnessShotRecord> {
  let record = recoverHarnessShot(options.record);
  if (["succeeded", "needs_review", "canceled"].includes(record.status)) return record;
  if (!["queued", "failed", "pending", "persisting"].includes(record.status)) {
    throw new Error(`shot 无法从 ${record.status} 开始执行`);
  }

  // 提交上下文随换家走（N3.4）：excluded 从记录里恢复——跨重启的重试同样不会把
  // 这面镜子再提交给已确定拒绝过它的家。
  const ctx: ShotSubmitContext = {
    provider: options.provider,
    models: options.models,
    shot: options.shot,
    excluded: [...(record.excludedProviders ?? [])],
  };
  while (true) {
    if (record.status === "failed") {
      record = prepareShotRetry(record, options.maxRetries ?? 2);
      await notify(options, record);
      if (record.status === "needs_review") return record;
    }
    const shot = options.shotOverride ? options.shotOverride(ctx.shot, record) : ctx.shot;
    if (record.status === "queued" && options.beforeAttempt) {
      try {
        await options.beforeAttempt(shot, record);
      } catch (error) {
        const failure =
          error instanceof ShotFailure
            ? error
            : new ShotFailure("internal", error instanceof Error ? error.message : String(error));
        record = transitionShot(record, "submitting");
        record = transitionShot(record, "failed", { error: { code: failure.code, message: failure.message } });
        await notify(options, record);
        if (failure.terminal) {
          record = transitionShot(record, "needs_review", { error: { code: failure.code, message: failure.message } });
          await notify(options, record);
          return record;
        }
        continue;
      }
    }
    ctx.shot = shot;
    record = await executeShotOnce({ ...options, shot, record }, ctx);
    if (record.status !== "failed") return record;
  }
}

/** Book this attempt's charge on top of what earlier attempts already spent. */
function attemptCost(record: HarnessShotRecord, charged: number | undefined): Pick<ShotPatch, "costUsd" | "costUnknown"> {
  const prior = record.priorCostUsd ?? 0;
  if (charged == null) return { costUsd: Math.max(record.costUsd, prior), costUnknown: true };
  return { costUsd: Math.round((prior + charged) * 1e6) / 1e6, ...(record.costUnknown ? { costUnknown: true } : {}) };
}

async function executeShotOnce(
  options: ShotExecutorOptions,
  ctx: ShotSubmitContext,
): Promise<HarnessShotRecord> {
  let current = recoverHarnessShot(options.record);
  let handle: ProviderHandle | undefined;
  try {
    if (await canceled(options)) return cancelShot(options, current);

    if (current.status === "queued") {
      current = transitionShot(current, "submitting");
      await notify(options, current);
      if (await canceled(options)) return cancelShot(options, current);

      // 确定拒绝换家循环：被拒的 submit 没有计费，换门是安全的；模糊失败直接
      // 抛出，由下面 catch 里的 uncertain_submit 路径收口（可能已受理，绝不重发）。
      while (true) {
        const request = buildShotRequest({
          jobId: options.jobId,
          shot: ctx.shot,
          bible: options.bible,
          resolveAsset: options.resolveAsset,
          models: ctx.models,
          caps: ctx.provider.capabilities(),
          aspectRatio: options.aspectRatio,
          resolution: options.resolution,
        });
        try {
          handle = await ctx.provider.submit(request);
          break;
        } catch (error) {
          if (
            error instanceof ProviderHttpError &&
            isCertainRejection(error) &&
            options.onCertainRejection
          ) {
            const next = await options.onCertainRejection(error, current, ctx);
            if (next) {
              ctx.provider = next.provider;
              ctx.models = next.models;
              ctx.shot = next.shot;
              ctx.excluded = next.excluded;
              continue;
            }
          }
          throw error;
        }
      }
      if (await canceled(options)) return cancelWithHandle(options, current, handle);
      if (handle.respectModeration === false) {
        throw new ShotFailure("moderation", "shot 未通过安全审核");
      }
      if (handle.remoteId) {
        current = transitionShot(current, "pending", {
          remoteId: handle.remoteId,
          ...submitContextPatch(ctx),
        });
        await notify(options, current);
      } else {
        current = transitionShot(current, "persisting", {
          ...attemptCost(current, handle.costUsdActual),
          ...submitContextPatch(ctx),
        });
        await notify(options, current);
      }
    } else if (current.status === "pending" || current.status === "persisting") {
      if (!current.remoteId) {
        throw new ShotFailure("internal", "shot 缺少 remoteId，无法续跑");
      }
      handle = { providerId: ctx.provider.id, remoteId: current.remoteId };
    } else {
      throw new Error(`shot 无法从 ${current.status} 开始执行`);
    }

    let finalHandle = handle!;
    if (current.status === "pending") {
      if (await canceled(options)) return cancelWithHandle(options, current, handle);
      const poll = await pollUntilDone(options, handle!, ctx.provider);
      if (poll.status === "failed") {
        throw new ShotFailure(poll.errorCode ?? "failed", poll.errorMessage ?? "shot 生成失败");
      }
      if (poll.status === "expired") {
        throw new ShotFailure("expired", poll.errorMessage ?? "shot 已过期");
      }
      if (poll.respectModeration === false) {
        throw new ShotFailure("moderation", "shot 未通过安全审核");
      }
      finalHandle = {
        ...handle!,
        remoteUrl: poll.remoteUrl ?? handle!.remoteUrl,
        fileOutputId: poll.fileOutputId ?? handle!.fileOutputId,
        costUsdActual: poll.usage?.costUsdActual ?? handle!.costUsdActual,
      };
      if (await canceled(options)) return cancelWithHandle(options, current, finalHandle);
      current = transitionShot(current, "persisting", {
        remoteId: finalHandle.remoteId,
        ...attemptCost(current, finalHandle.costUsdActual),
      });
      await notify(options, current);
    }

    if (current.status !== "persisting") {
      throw new Error(`shot 无法从 ${current.status} 落盘`);
    }
    if (await canceled(options)) return cancelWithHandle(options, current, finalHandle);
    if (
      !finalHandle.remoteUrl &&
      !finalHandle.fileOutputId &&
      !finalHandle.localVideoPath &&
      finalHandle.remoteId
    ) {
      const poll = await pollUntilDone(options, finalHandle, ctx.provider);
      if (poll.status === "failed") {
        throw new ShotFailure(poll.errorCode ?? "failed", poll.errorMessage ?? "shot 生成失败");
      }
      if (poll.status === "expired") {
        throw new ShotFailure("expired", poll.errorMessage ?? "shot 已过期");
      }
      if (poll.respectModeration === false) {
        throw new ShotFailure("moderation", "shot 未通过安全审核");
      }
      finalHandle = {
        ...finalHandle,
        remoteUrl: poll.remoteUrl ?? finalHandle.remoteUrl,
        fileOutputId: poll.fileOutputId ?? finalHandle.fileOutputId,
        costUsdActual: poll.usage?.costUsdActual ?? finalHandle.costUsdActual,
      };
    }

    const persisted = await options.persistOutput(options.shot, finalHandle);
    const outputPath = typeof persisted === "string" ? persisted : persisted.outputPath;
    if (await canceled(options)) {
      await cleanupOutput(options, outputPath);
      return cancelWithHandle(options, current, finalHandle);
    }
    current = transitionShot(current, "succeeded", {
      outputPath,
      ...attemptCost(current, finalHandle.costUsdActual),
      ...(typeof persisted === "string" || !persisted.qc ? {} : { qc: persisted.qc }),
    });
    await notify(options, current);
    return current;
  } catch (error) {
    if (current.status === "succeeded") return current;
    if (error instanceof ShotCanceled) {
      return cancelWithHandle(options, current, handle);
    }
    if (await canceled(options)) {
      return cancelWithHandle(options, current, handle);
    }
    if (!canTransitionShot(current.status, "failed")) throw error;
    // 提交阶段的模糊失败（读超时 / 中途断连 / 裸 5xx）：上游可能已受理这条请求，
    // 让它走自动重试等于同一面镜子付两次钱——直接判 `uncertain_submit` 进人工复核，
    // 与崩溃在「submit 后 remoteId 落盘前」的恢复判定同一个口径（shot-recover）。
    const failure =
      error instanceof ShotFailure
        ? error
        : isAmbiguousSubmitError(error) && current.status === "submitting"
          ? new ShotFailure("uncertain_submit", UNCERTAIN_SUBMIT_MESSAGE, { terminal: true })
          : new ShotFailure(
              error instanceof ProviderHttpError ? error.code : "internal",
              error instanceof Error ? error.message : String(error),
              // 确定拒绝换家名额已尽：按终态失败进复核，不再消耗重试预算撞同一堵墙。
              { terminal: isCertainRejection(error) },
            );
    const failed = transitionShot(current, "failed", {
      error: { code: failure.code, message: failure.message },
      // 被拒过的家与落点随失败一起落盘：这条镜的自动重试与人工重做都不再把
      // 它提交给同一家。
      ...submitContextPatch(ctx),
    });
    await notify(options, failed);
    if (!failure.terminal) return failed;
    // A terminal failure raised mid-attempt (e.g. the visual-QC budget reserve) must not buy
    // another attempt just so the retry's own gate can stop it; escalate here, same as the
    // beforeAttempt path does.
    const reviewed = transitionShot(failed, "needs_review", {
      error: { code: failure.code, message: failure.message },
    });
    await notify(options, reviewed);
    return reviewed;
  }
}

async function pollUntilDone(
  options: ShotExecutorOptions,
  handle: ProviderHandle,
  provider: VideoProvider,
): Promise<ProviderPoll> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const intervalMs = options.pollIntervalMs ?? 2000;
  while (Date.now() - started < timeoutMs) {
    if (await canceled(options)) throw new ShotCanceled();
    // 轮询走提交实际落点的那家（换家后 ctx.provider 已更新，不能用 options.provider）。
    const result = await provider.poll(handle);
    if (await canceled(options)) throw new ShotCanceled();
    if (result.status !== "pending") return result;
    if (intervalMs > 0) await sleep(intervalMs);
  }
  throw new ShotFailure("timeout", "shot 等待生成超时");
}

async function canceled(options: ShotExecutorOptions): Promise<boolean> {
  return options.isCanceled ? options.isCanceled() : false;
}

async function cancelWithHandle(
  options: ShotExecutorOptions,
  record: HarnessShotRecord,
  handle?: ProviderHandle,
): Promise<HarnessShotRecord> {
  if (handle && options.cleanupHandle) {
    await options.cleanupHandle(handle).catch(() => undefined);
  }
  return cancelShot(options, record);
}

async function cleanupOutput(options: ShotExecutorOptions, outputPath: string) {
  if (options.cleanupOutput) await options.cleanupOutput(outputPath).catch(() => undefined);
}

async function cancelShot(
  options: ShotExecutorOptions,
  record: HarnessShotRecord,
): Promise<HarnessShotRecord> {
  const next = transitionShot(record, "canceled");
  await notify(options, next);
  return next;
}

const ROUTE_MODEL_KEY = {
  t2v: "text_to_video",
  i2v: "image_to_video",
  r2v: "reference_to_video",
} as const;

/**
 * 提交上下文的落盘补丁：本镜实际用了哪家、哪个模型、被拒过哪些家。
 * 没换过家时 excluded 为空不写——老记录与未换家记录保持干净。
 */
function submitContextPatch(ctx: ShotSubmitContext): ShotPatch {
  return {
    provider: ctx.provider.id,
    model: ctx.models[ROUTE_MODEL_KEY[ctx.shot.route]],
    ...(ctx.excluded.length ? { excludedProviders: [...ctx.excluded] } : {}),
  };
}

async function notify(options: ShotExecutorOptions, record: HarnessShotRecord) {
  await options.onState?.(record);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ShotFailure extends Error {
  /** Terminal failures skip the retry budget and go straight to needs_review. */
  readonly terminal: boolean;
  constructor(
    readonly code: string,
    message: string,
    options: { terminal?: boolean } = {},
  ) {
    super(message);
    this.name = "ShotFailure";
    this.terminal = options.terminal ?? false;
  }
}

class ShotCanceled extends Error {
  constructor() {
    super("shot 已取消");
    this.name = "ShotCanceled";
  }
}
