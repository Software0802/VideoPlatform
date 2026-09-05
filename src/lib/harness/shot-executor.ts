import { buildShotRequest, type BuildShotRequestInput } from "./shot-router";
import { recoverHarnessShot } from "./shot-recover";
import {
  canTransitionShot,
  prepareShotRetry,
  transitionShot,
  type HarnessShotRecord,
  type ShotPatch,
} from "./shot-state";
import type { IdentityBible, Shot } from "./types";
import type {
  MediaRef,
  ProviderHandle,
  ProviderPoll,
  VideoProvider,
} from "@/lib/providers/types";

export type ShotOutputPersister = (
  shot: Shot,
  handle: ProviderHandle,
) => Promise<string | { outputPath: string; qc?: HarnessShotRecord["qc"] }>;

export type ShotExecutorOptions = {
  jobId: string;
  shot: Shot;
  bible: IdentityBible;
  record: HarnessShotRecord;
  provider: VideoProvider;
  resolveAsset: BuildShotRequestInput["resolveAsset"];
  sourceVideo?: MediaRef;
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
};

export async function executeShotWithRetries(
  options: ShotExecutorOptions,
): Promise<HarnessShotRecord> {
  let record = recoverHarnessShot(options.record);
  if (["succeeded", "needs_review", "canceled"].includes(record.status)) return record;
  if (!["queued", "failed", "pending", "persisting"].includes(record.status)) {
    throw new Error(`shot 无法从 ${record.status} 开始执行`);
  }

  while (true) {
    if (record.status === "failed") {
      record = prepareShotRetry(record, options.maxRetries ?? 2);
      await notify(options, record);
      if (record.status === "needs_review") return record;
    }
    const shot = options.shotOverride ? options.shotOverride(options.shot, record) : options.shot;
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
    record = await executeShotOnce({ ...options, shot, record });
    if (record.status !== "failed") return record;
  }
}

/** Book this attempt's charge on top of what earlier attempts already spent. */
function attemptCost(record: HarnessShotRecord, charged: number | undefined): Pick<ShotPatch, "costUsd" | "costUnknown"> {
  const prior = record.priorCostUsd ?? 0;
  if (charged == null) return { costUsd: Math.max(record.costUsd, prior), costUnknown: true };
  return { costUsd: Math.round((prior + charged) * 1e6) / 1e6, ...(record.costUnknown ? { costUnknown: true } : {}) };
}

async function executeShotOnce(options: ShotExecutorOptions): Promise<HarnessShotRecord> {
  let current = recoverHarnessShot(options.record);
  let handle: ProviderHandle | undefined;
  try {
    if (await canceled(options)) return cancelShot(options, current);

    if (current.status === "queued") {
      current = transitionShot(current, "submitting");
      await notify(options, current);
      if (await canceled(options)) return cancelShot(options, current);

      const request = buildShotRequest({
        jobId: options.jobId,
        shot: options.shot,
        bible: options.bible,
        resolveAsset: options.resolveAsset,
        sourceVideo: options.sourceVideo,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
      });
      handle = await options.provider.submit(request);
      if (await canceled(options)) return cancelWithHandle(options, current, handle);
      if (handle.respectModeration === false) {
        throw new ShotFailure("moderation", "shot 未通过安全审核");
      }
      if (handle.remoteId) {
        current = transitionShot(current, "pending", { remoteId: handle.remoteId });
        await notify(options, current);
      } else {
        current = transitionShot(current, "persisting", attemptCost(current, handle.costUsdActual));
        await notify(options, current);
      }
    } else if (current.status === "pending" || current.status === "persisting") {
      if (!current.remoteId) {
        throw new ShotFailure("internal", "shot 缺少 remoteId，无法续跑");
      }
      handle = { providerId: options.provider.id, remoteId: current.remoteId };
    } else {
      throw new Error(`shot 无法从 ${current.status} 开始执行`);
    }

    let finalHandle = handle!;
    if (current.status === "pending") {
      if (await canceled(options)) return cancelWithHandle(options, current, handle);
      const poll = await pollUntilDone(options, handle!);
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
      const poll = await pollUntilDone(options, finalHandle);
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
    const failure =
      error instanceof ShotFailure
        ? error
        : new ShotFailure("internal", error instanceof Error ? error.message : String(error));
    const failed = transitionShot(current, "failed", {
      error: { code: failure.code, message: failure.message },
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
): Promise<ProviderPoll> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const intervalMs = options.pollIntervalMs ?? 2000;
  while (Date.now() - started < timeoutMs) {
    if (await canceled(options)) throw new ShotCanceled();
    const result = await options.provider.poll(handle);
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
