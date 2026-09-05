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

export const jobPublicSchema = z.object({
  id: z.string(),
  status: jobStatusSchema,
  progress: z.number().finite().min(0).max(100),
  mode: nativeModeSchema,
  model: z.string(),
  provider: z.enum(["grok", "mock", "jimeng"]),
  prompt: z.string(),
  durationSec: z.number(),
  aspectRatio: aspectRatioSchema.nullable(),
  resolution: resolutionSchema.nullable(),
  generateAudio: z.boolean(),
  lastFrameStored: z.boolean(),
  lastFrameLocksOutput: z.literal(false),
  harness: z.object({ enabled: z.boolean() }),
  costUsdEstimate: z.number(),
  costUsdActual: z.number().nullable(),
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
  bible: z.null(),
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
  role: UploadRole;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  durationSec: number | null;
  createdAt: string;
};

export type JobAssetImage = { path: string; width: number; height: number };
export type JobAssetVideo = JobAssetImage & {
  durationSec: number;
  xaiFileId: string | null;
};

export type JobRecord = JobPublic & {
  schemaVersion: 1;
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
};
