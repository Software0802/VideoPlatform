import { z } from "zod";
import type { HarnessShotRecord } from "@/lib/harness/shot-state";
import type { HarnessPlan } from "@/lib/harness/types";
import { ASPECT_RATIOS, RESOLUTIONS } from "@/lib/providers/grok/mode-matrix";

export const nativeModeSchema = z.enum([
  "text_to_image",
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit_video",
  "extend_video",
]);

export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export const resolutionSchema = z.enum(RESOLUTIONS);
export const imageResolutionSchema = z.enum(["1k", "2k"]);
export const jobStatusSchema = z.enum([
  "queued",
  "submitting",
  "pending",
  "persisting",
  "directing",
  "keyframing",
  "generating_shots",
  "qc",
  "stitching",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * Statuses with no outgoing edges in `state-machine.ts`. Lives here rather than
 * next to the transition table so that both the store (which stamps
 * `completedAt` on the way in) and the quota counter (which reads it back) share
 * one definition instead of two hand-kept copies.
 */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const jobPublicSchema = z.object({
  id: z.string(),
  status: jobStatusSchema,
  progress: z.number().finite().min(0).max(100),
  mode: nativeModeSchema,
  model: z.string(),
  provider: z.enum(["grok", "mock", "jimeng", "openai", "kling"]),
  prompt: z.string(),
  durationSec: z.number(),
  aspectRatio: aspectRatioSchema.nullable(),
  resolution: resolutionSchema.nullable(),
  generateAudio: z.boolean(),
  lastFrameStored: z.boolean(),
  lastFrameLocksOutput: z.literal(false),
  harness: z.object({ enabled: z.boolean() }),
  /** Estimate shown at submit time; never rewritten afterwards (R05). */
  costUsdEstimate: z.number(),
  /** Harness: estimate recomputed from the Director's packing, shown beside the submit-time
   * one. The budget cap does NOT derive from it — see `budgetCap` / evals/rubric.md §5. */
  costUsdPlanned: z.number().nullable().optional(),
  /** Sum of every charge the upstream reported (shots, sheets, retries). */
  costUsdActual: z.number().nullable(),
  /** True when a paid call returned no usage or LLM calls were made without a price table: actual is a lower bound. */
  costIncomplete: z.boolean().optional(),
  /** Soft warning (evals/rubric.md §5): actual spend passed 1.5 × the submit-time estimate.
   * Nothing stops; the job just no longer counts as cost-compliant. The hard stop stays at ×2. */
  costOverTarget: z.boolean().optional(),
  imageResolution: imageResolutionSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  output: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("video"),
        videoUrl: z.string(),
        posterUrl: z.string(),
        durationSec: z.number(),
      }),
      z.object({
        kind: z.literal("image"),
        imageUrl: z.string(),
      }),
    ])
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * When the retention sweep deleted this job's `inputs/` and `outputs/` (plan §8),
   * ISO, or null. `status` deliberately stays `succeeded`: terminal statuses have no
   * outgoing edges, so artifact retention is a second axis rather than a state
   * transition. The browser needs it to render a placeholder instead of requesting
   * bytes that are no longer on disk.
   */
  artifactsPurgedAt: z.string().nullable(),
  bible: z.null(),
  /** Set when a shot may already have been paid for upstream: one-click Retry is refused
   * server-side (409 `retry_blocked`) and the UI shows `message` instead of the button. */
  retryBlocked: z
    .object({
      code: z.literal("uncertain_submit"),
      message: z.string(),
      shotIndexes: z.array(z.number().int().min(0)),
    })
    .nullable(),
  /** Harness jobs expose per-shot progress; native clips keep null. */
  shots: z
    .array(
      z.object({
        id: z.string(),
        index: z.number().int().min(0),
        durationSec: z.number(),
        status: z.string(),
        retries: z.number().int().min(0),
        error: z.object({ code: z.string(), message: z.string() }).nullable(),
      }),
    )
    .nullable(),
});

export type JobPublic = z.infer<typeof jobPublicSchema>;

/** Keep provider/user-controlled progress inside the public 0–100 contract. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export const UPLOAD_ID_RE = /^up_[0-9a-f]{16}$/;
export const uploadIdSchema = z.string().regex(UPLOAD_ID_RE);

export const createJobBodySchema = z.object({
  mode: nativeModeSchema,
  prompt: z.string().max(2000).default(""),
  durationSec: z.number().optional(),
  aspectRatio: aspectRatioSchema.optional(),
  resolution: resolutionSchema.optional(),
  generateAudio: z.boolean().optional(),
  imageResolution: imageResolutionSchema.optional(),
  startUploadId: uploadIdSchema.optional(),
  lastUploadId: uploadIdSchema.optional(),
  referenceUploadIds: z.array(uploadIdSchema).max(7).optional(),
  voiceIds: z.array(z.string()).max(3).optional(),
  sourceVideoUploadId: uploadIdSchema.optional(),
  idempotencyKey: z.string().optional(),
}).strict();

export type CreateJobBody = z.infer<typeof createJobBodySchema>;

export const uploadRoleSchema = z.enum(["start", "last", "reference", "source_video"]);
export type UploadRole = z.infer<typeof uploadRoleSchema>;

export type UploadSidecar = {
  uploadId: string;
  /**
   * Who uploaded the file (plan §5.3). Without it, knowing someone else's
   * upload id was enough to claim their file into your own job. Missing means a
   * pre-user-system upload, which `createJob` treats as non-existent.
   */
  ownerId?: string;
  role: UploadRole;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  durationSec: number | null;
  createdAt: string;
};

/**
 * Director / visual-QC token ledger. `unpricedCalls` and `costUsd` were added after
 * the first harness runs, so job.json files written before that omit them; every read
 * goes through `normalizeLlmUsage`, which reads a missing field as 0.
 */
export type JobLlmUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Calls that finished without upstream usage: `costUsd` is a lower bound (default 0). */
  unpricedCalls?: number;
  /** List-price estimate of the priced calls, folded into `costUsdActual` (default 0). */
  costUsd?: number;
};

export type NormalizedLlmUsage = Required<JobLlmUsage>;

export function normalizeLlmUsage(usage: JobLlmUsage | null | undefined): NormalizedLlmUsage {
  return {
    calls: usage?.calls ?? 0,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    unpricedCalls: usage?.unpricedCalls ?? 0,
    costUsd: usage?.costUsd ?? 0,
  };
}

export type JobAssetImage = { path: string; width: number; height: number };
export type JobAssetVideo = JobAssetImage & {
  durationSec: number;
  xaiFileId: string | null;
};

/**
 * `retryBlocked` is derived from `harnessShots` at `toPublic` time, never stored, so it is
 * omitted here — otherwise every writer of a record would have to carry a computed field.
 */
export type JobRecord = Omit<JobPublic, "retryBlocked" | "artifactsPurgedAt"> & {
  schemaVersion: 1;
  /**
   * Set once by the retention sweep (`retention.ts`) after it deleted the job's
   * `inputs/` and `outputs/`. Absent on every record that still has its bytes,
   * which is why it is optional here and `string | null` on the public DTO.
   */
  artifactsPurgedAt?: string;
  /**
   * Owning user (plan §5). Deliberately absent from `JobPublic`: the browser
   * never needs it and must not learn other people's user ids. Missing means a
   * pre-user-system job — see `canAccessJob`.
   */
  ownerId?: string;
  /**
   * When the job first reached a terminal status, ISO. Stamped once by
   * `store.updateJob` and never rewritten, so a later write (a产物 sweep, a
   * cost correction) cannot move the job to another day.
   *
   * The daily quota buckets settled jobs by this, not by `createdAt`: a job
   * submitted at 23:59 and finished at 00:05 belongs to the day it *finished*,
   * otherwise it counts towards neither day and comes out free. Records written
   * before this field existed fall back to `updatedAt`.
   */
  completedAt?: string;
  remoteId?: string;
  remoteUrl?: string;
  fileOutputId?: string;
  localOutputPath?: string;
  canceled?: boolean;
  assets: {
    start?: JobAssetImage;
    last?: JobAssetImage;
    references?: JobAssetImage[];
    source?: JobAssetVideo;
  };
  voiceIds?: string[];
  /** Internal Phase 2 snapshot; omitted from the Phase 1 public DTO. */
  harnessPlan?: HarnessPlan | null;
  harnessShots?: HarnessShotRecord[] | null;
  /** Director / visual-QC token ledger; see `normalizeLlmUsage` for legacy records. */
  llmUsage?: JobLlmUsage;
  /** Whole-film check after stitching (R08). */
  harnessStitch?: { durationSec: number; expectedSec: number; settleSec: number; toleranceSec: number };
};
