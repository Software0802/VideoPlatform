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

export const harnessShotRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    index: z.number().int().min(0).max(999),
    status: harnessShotStatusSchema,
    remoteId: z.string().trim().min(1).optional(),
    outputPath: z.string().trim().min(1).optional(),
    retries: z.number().int().min(0).max(2),
    costUsd: z.number().finite().min(0),
    error: shotErrorSchema.nullable().optional(),
  })
  .strict();

export type HarnessShotRecord = z.infer<typeof harnessShotRecordSchema>;

export type ShotPatch = {
  remoteId?: string;
  outputPath?: string;
  costUsd?: number;
  error?: HarnessShotRecord["error"];
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
      error: { code: "retry_exhausted", message: "shot 自动重试次数已用尽" },
    });
  }
  const next = { ...record, status: "queued" as const, retries: record.retries + 1 };
  delete next.remoteId;
  delete next.outputPath;
  delete next.error;
  return harnessShotRecordSchema.parse(next);
}

export function runnableShots(records: readonly HarnessShotRecord[]): HarnessShotRecord[] {
  return records
    .filter((record) => record.status === "queued")
    .sort((a, b) => a.index - b.index)
    .map((record) => ({ ...record }));
}
