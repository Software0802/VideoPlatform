import { z } from "zod";
import type { Shot } from "./types";

export const harnessShotStatusSchema = z.enum([
  "queued",
  "submitting",
  "pending",
  "persisting",
  "succeeded",
  "failed",
  "needs_review",
  "canceled",
]);
export type HarnessShotStatus = z.infer<typeof harnessShotStatusSchema>;

const shotErrorSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict();

export const shotQcSchema = z
  .object({
    durationSec: z.number().finite().min(0),
    durationOk: z.boolean(),
    blackFrameFree: z.boolean(),
    freezeFree: z.boolean(),
    visualScore: z.number().min(0).max(1).optional(),
  })
  .strict();
export type ShotQc = z.infer<typeof shotQcSchema>;

export const harnessShotRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    index: z.number().int().min(0).max(999),
    status: harnessShotStatusSchema,
    remoteId: z.string().trim().min(1).optional(),
    outputPath: z.string().trim().min(1).optional(),
    retries: z.number().int().min(0).max(2),
    /** Cumulative spend across every attempt of this shot (R05). */
    costUsd: z.number().finite().min(0),
    /** Spend booked by attempts before the current one; the executor adds the current attempt on top. */
    priorCostUsd: z.number().finite().min(0).optional(),
    /** A paid attempt finished without usage data: costUsd is a lower bound, not a total. */
    costUnknown: z.boolean().optional(),
    error: shotErrorSchema.nullable().optional(),
    qc: shotQcSchema.optional(),
    /** 本镜实际被提交给的 provider（确定拒单换家后与 job.provider 可能不同）。 */
    provider: z.string().trim().min(1).max(64).optional(),
    /** 本镜换家用的模型名（按 shot.route 取的新家模型；估价重算读它）。 */
    model: z.string().trim().min(1).max(160).optional(),
    /**
     * 本镜已经试过并确定被拒的 provider（N3.4）：换家与重试都不得再把这条镜
     * 提交给它们——被拒的请求没计费，但把同一条请求摊到每家上游不是重试，是扩散。
     */
    excludedProviders: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  })
  .strict();

export type HarnessShotRecord = z.infer<typeof harnessShotRecordSchema>;

export type ShotPatch = {
  remoteId?: string;
  outputPath?: string;
  costUsd?: number;
  costUnknown?: boolean;
  error?: HarnessShotRecord["error"];
  qc?: ShotQc;
  provider?: string;
  model?: string;
  excludedProviders?: string[];
};

const allowed: Record<HarnessShotStatus, HarnessShotStatus[]> = {
  queued: ["submitting", "canceled", "needs_review"],
  submitting: ["pending", "persisting", "failed", "canceled"],
  pending: ["persisting", "failed", "canceled"],
  persisting: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: ["needs_review"],
  needs_review: [],
  canceled: [],
};

export function createShotRecords(shots: readonly Shot[]): HarnessShotRecord[] {
  if (!shots.length) throw new Error("shot 计划不能为空");
  const ids = new Set<string>();
  return shots.map((shot, position) => {
    if (ids.has(shot.id) || shot.index !== position) throw new Error("shot 计划无效");
    ids.add(shot.id);
    return {
      id: shot.id,
      index: shot.index,
      status: "queued",
      retries: 0,
      costUsd: 0,
    };
  });
}

export function canTransitionShot(from: HarnessShotStatus, to: HarnessShotStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function transitionShot(
  record: HarnessShotRecord,
  to: HarnessShotStatus,
  patch: ShotPatch = {},
): HarnessShotRecord {
  if (!canTransitionShot(record.status, to)) {
    throw new Error(`illegal shot transition ${record.status} -> ${to}`);
  }
  const next = harnessShotRecordSchema.parse({ ...record, status: to, ...patch });
  if (to === "succeeded" && !next.outputPath) throw new Error("成功 shot 缺少 outputPath");
  return next;
}

export function prepareShotRetry(
  record: HarnessShotRecord,
  maxRetries = 2,
): HarnessShotRecord {
  if (record.status !== "failed") throw new Error("仅失败 shot 可重试");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new Error("shot 重试上限无效");
  }
  if (record.retries >= maxRetries) {
    return harnessShotRecordSchema.parse({
      ...record,
      status: "needs_review",
      error: {
        code: "retry_exhausted",
        message: record.error
          ? `shot 自动重试次数已用尽（最后错误 ${record.error.code}: ${record.error.message}）`
          : "shot 自动重试次数已用尽",
      },
    });
  }
  // Money already spent on the failed attempt stays on the books: the next attempt adds to it.
  const next = {
    ...record,
    status: "queued" as const,
    retries: record.retries + 1,
    priorCostUsd: record.costUsd,
  };
  delete next.remoteId;
  delete next.outputPath;
  delete next.error;
  delete next.qc;
  return harnessShotRecordSchema.parse(next);
}

export function runnableShots(records: readonly HarnessShotRecord[]): HarnessShotRecord[] {
  return records
    .filter((record) => record.status === "queued")
    .sort((a, b) => a.index - b.index)
    .map((record) => ({ ...record }));
}
