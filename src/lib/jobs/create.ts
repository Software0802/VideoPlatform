import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { estimateCostUsd, estimateHarnessCostUsd } from "@/lib/cost";
import { packHarnessDuration } from "@/lib/harness/pack-duration";
import { harnessEnabled, maxQueuedJobs } from "@/lib/env";
import {
  UPLOAD_ID_RE,
  type CreateJobBody,
  type JobPublic,
  type JobRecord,
  type UploadSidecar,
} from "@/lib/jobs/schema";
import { ProviderHttpError } from "@/lib/providers/types";
import { withAdmissionLock } from "@/lib/jobs/admission";
import { lookupIdempotency, saveIdempotency } from "@/lib/jobs/idempotency";
import { activeCount, enqueue } from "@/lib/jobs/runner";
import { assertCreateJobFields } from "@/lib/jobs/request-validation";
import { resolveLocalOutput } from "@/lib/jobs/local-output";
import { retryBlock } from "@/lib/jobs/retry-guard";
import { readJob, tmpDir, toPublic, writeJob } from "@/lib/jobs/store";
import { isHarnessDuration, isImageMode, modelForMode } from "@/lib/providers/grok/mode-matrix";
import { assertModeConstraints } from "@/lib/providers/grok/rest-map";
import { currentProviderId } from "@/lib/providers/router";
import { mediaStore } from "@/lib/storage/local-fs";

export async function createJob(body: CreateJobBody) {
  return withAdmissionLock(() => createJobUnlocked(body));
}

async function createJobUnlocked(body: CreateJobBody) {
  if (body.idempotencyKey) {
    const existing = await lookupIdempotency(body.idempotencyKey);
    if (existing) {
      const rec = await readJob(existing);
      if (rec) return { job: toPublic(rec), replay: true };
    }
  }

  assertCreateJobFields(body);

  const n = await activeCount();
  if (n >= maxQueuedJobs()) {
    throw new ProviderHttpError(429, "queue_full", "队列已满，请等待进行中的任务完成");
  }

  const mode = body.mode;
  const image = isImageMode(mode);
  const durationSec = image
    ? 0
    : mode === "edit_video"
      ? undefined
      : (body.durationSec ?? (mode === "extend_video" ? 6 : 8));
  const harness = !image && mode !== "edit_video" && isHarnessDuration(durationSec);
  if (harness) {
    if (!harnessEnabled()) {
      throw new ProviderHttpError(400, "harness_duration", "长视频将由一致性管线提供，尚未开放");
    }
    if (mode !== "text_to_video" && mode !== "image_to_video") {
      throw new ProviderHttpError(400, "invalid_argument", "30 / 45 / 60 秒长片仅支持文生视频与图生视频");
    }
  }

  const start = body.startUploadId ? await loadSidecar(body.startUploadId, "start") : undefined;
  const last = body.lastUploadId ? await loadSidecar(body.lastUploadId, "last") : undefined;
  const refs = body.referenceUploadIds
    ? await Promise.all(body.referenceUploadIds.map((id) => loadSidecar(id, "reference")))
    : [];
  const source = body.sourceVideoUploadId
    ? await loadSidecar(body.sourceVideoUploadId, "source_video")
    : undefined;

  if (mode === "edit_video" && source && (source.durationSec ?? 0) > 8.7) {
    throw new ProviderHttpError(400, "invalid_argument", "编辑源片最长 8.7 秒");
  }
  if (mode === "extend_video" && source) {
    const d = source.durationSec ?? 0;
    if (d < 2 || d > 15) {
      throw new ProviderHttpError(400, "invalid_argument", "延长源片须为 2–15 秒");
    }
  }

  const model = modelForMode(mode);
  assertModeConstraints({
    jobId: "preview",
    mode,
    prompt: body.prompt,
    model,
    // Harness jobs never send 30/45/60 upstream; validate the other fields with a legal clip length.
    durationSec:
      mode === "edit_video" || image ? body.durationSec : harness ? 15 : (body.durationSec ?? durationSec),
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    imageResolution: image ? (body.imageResolution ?? "1k") : undefined,
    generateAudio: image ? false : (body.generateAudio ?? true),
    startImage: start ? { kind: "data_uri", dataUri: "data:image/jpeg;base64,aa" } : undefined,
    referenceImages: refs.map(() => ({ kind: "data_uri", dataUri: "data:image/jpeg;base64,aa" })),
    referenceAudios: body.voiceIds?.map((voiceId) => ({ voiceId })),
    sourceVideo: source ? { kind: "file_id", fileId: "pending" } : undefined,
  });

  const id = `job_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const dur = image ? 0 : mode === "edit_video" ? (source?.durationSec ?? 0) : (durationSec ?? 8);
  const rec: JobRecord = {
    schemaVersion: 1,
    id,
    status: "queued",
    progress: 0,
    mode,
    model,
    provider: currentProviderId(),
    prompt: body.prompt,
    durationSec: dur,
    aspectRatio:
      mode === "edit_video" || mode === "extend_video" ? null : (body.aspectRatio ?? "16:9"),
    resolution:
      mode === "edit_video" || mode === "extend_video" || image ? null : (body.resolution ?? "720p"),
    imageResolution: image ? (body.imageResolution ?? "1k") : null,
    generateAudio: image ? false : (body.generateAudio ?? true),
    lastFrameStored: Boolean(last),
    lastFrameLocksOutput: false,
    harness: { enabled: harness },
    costUsdEstimate: harness
      ? estimateHarnessCostUsd(packHarnessDuration(dur as 30 | 45 | 60))
      : estimateCostUsd(model, dur),
    costUsdActual: null,
    error: null,
    output: null,
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    voiceIds: body.voiceIds,
  };

  await mkdir(path.join(mediaStore.jobDir(id), "inputs"), { recursive: true });
  if (start) rec.assets.start = await claim(id, start, "inputs/start.jpg");
  if (last) rec.assets.last = await claim(id, last, "inputs/last.jpg");
  if (refs.length) {
    rec.assets.references = [];
    for (let i = 0; i < refs.length; i++) {
      rec.assets.references.push(await claim(id, refs[i], `inputs/ref-${i}.jpg`));
    }
  }
  if (source) {
    const a = await claim(id, source, "inputs/source.mp4");
    rec.assets.source = {
      ...a,
      durationSec: source.durationSec ?? 0,
      xaiFileId: null,
    };
  }

  await writeJob(rec);
  if (body.idempotencyKey) await saveIdempotency(body.idempotencyKey, id);
  enqueue(id);
  return { job: toPublic(rec), replay: false };
}

export async function retryJob(source: JobRecord): Promise<JobPublic> {
  return withAdmissionLock(() => retryJobUnlocked(source));
}

async function retryJobUnlocked(source: JobRecord): Promise<JobPublic> {
  if (source.status !== "failed" && source.status !== "expired") {
    throw new ProviderHttpError(409, "conflict", "仅失败或过期任务可重试");
  }
  // A shot whose submit outcome is unknown may already be paid for upstream; re-queuing it
  // at costUsd 0 would buy it a second time. Refuse before anything is written or copied.
  const block = retryBlock(source);
  if (block) {
    throw new ProviderHttpError(409, "retry_blocked", block.message);
  }
  const n = await activeCount();
  if (n >= maxQueuedJobs()) {
    throw new ProviderHttpError(429, "queue_full", "队列已满，请等待进行中的任务完成");
  }

  const id = `job_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const rec: JobRecord = {
    schemaVersion: 1,
    id,
    status: "queued",
    progress: 0,
    mode: source.mode,
    model: source.model,
    provider: currentProviderId(),
    prompt: source.prompt,
    durationSec: source.durationSec,
    aspectRatio: source.aspectRatio,
    resolution: source.resolution,
    imageResolution: source.imageResolution ?? null,
    generateAudio: source.generateAudio,
    lastFrameStored: source.lastFrameStored,
    lastFrameLocksOutput: false,
    harness: { enabled: Boolean(source.harness?.enabled) },
    costUsdEstimate: source.costUsdEstimate,
    costUsdPlanned: source.costUsdPlanned ?? null,
    costUsdActual: null,
    error: null,
    output: null,
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    voiceIds: source.voiceIds,
  };

  const srcInputs = path.join(mediaStore.jobDir(source.id), "inputs");
  const destInputs = path.join(mediaStore.jobDir(id), "inputs");
  try {
    await cp(srcInputs, destInputs, { recursive: true });
  } catch {
    await mkdir(destInputs, { recursive: true });
  }

  if (source.assets.start) rec.assets.start = { ...source.assets.start };
  if (source.assets.last) rec.assets.last = { ...source.assets.last };
  if (source.assets.references) rec.assets.references = source.assets.references.map((a) => ({ ...a }));
  if (source.assets.source) {
    rec.assets.source = { ...source.assets.source, xaiFileId: null };
  }

  // Harness retry keeps the plan and every succeeded shot; only failed / needs_review shots
  // are re-queued, so a human "Retry" does not re-direct and re-pay for the whole film (R09).
  if (source.harnessPlan && source.harnessShots) {
    const kept = source.harnessShots.map((shot) =>
      shot.status === "succeeded"
        ? { ...shot }
        : { id: shot.id, index: shot.index, status: "queued" as const, retries: 0, costUsd: 0 },
    );
    const keptCost = kept.reduce((sum, s) => sum + s.costUsd, 0);
    rec.harnessPlan = source.harnessPlan;
    rec.harnessShots = kept;
    rec.costUsdActual = keptCost > 0 ? Math.round(keptCost * 100) / 100 : null;
    rec.costIncomplete = kept.some((s) => s.costUnknown) || undefined;
    const srcShots = path.join(mediaStore.jobDir(source.id), "shots");
    const destShots = path.join(mediaStore.jobDir(id), "shots");
    // Kept shots are booked as paid and finished, so their clips must really arrive in the new
    // job dir; otherwise stitch would fail later against a ledger that says everything is fine.
    // Tail frames and the like are best-effort, so only the kept outputs are verified.
    const keptOutputs = kept.flatMap((s) => (s.status === "succeeded" && s.outputPath ? [s.outputPath] : []));
    try {
      await cp(srcShots, destShots, { recursive: true });
      for (const rel of keptOutputs) await access(resolveLocalOutput(mediaStore.jobDir(id), rel));
    } catch (error) {
      if (keptOutputs.length) {
        await rm(mediaStore.jobDir(id), { recursive: true, force: true }).catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        throw new ProviderHttpError(
          500,
          "retry_copy_failed",
          `无法复制已完成分镜的成片（${detail}），重试未创建；请确认原任务目录完整后再试`,
        );
      }
    }
  }

  await writeJob(rec);
  enqueue(id);
  return toPublic(rec);
}

async function loadSidecar(uploadId: string, expected: UploadSidecar["role"]): Promise<UploadSidecar> {
  if (!UPLOAD_ID_RE.test(uploadId)) {
    throw new ProviderHttpError(400, "invalid_argument", "上传文件不存在或已过期");
  }
  const p = path.join(tmpDir(), `${uploadId}.json`);
  let raw: UploadSidecar;
  try {
    raw = JSON.parse(await readFile(p, "utf8")) as UploadSidecar;
  } catch {
    throw new ProviderHttpError(400, "invalid_argument", "上传文件不存在或已过期");
  }
  if (raw.uploadId !== uploadId || !UPLOAD_ID_RE.test(raw.uploadId)) {
    throw new ProviderHttpError(400, "invalid_argument", "上传文件不存在或已过期");
  }
  if (raw.role !== expected) {
    throw new ProviderHttpError(400, "invalid_argument", "上传文件角色不匹配");
  }
  return raw;
}

async function claim(jobId: string, side: UploadSidecar, destRel: string) {
  if (!UPLOAD_ID_RE.test(side.uploadId)) {
    throw new ProviderHttpError(400, "invalid_argument", "上传文件不存在或已过期");
  }
  const src = path.join(tmpDir(), side.uploadId);
  const dest = path.join(mediaStore.jobDir(jobId), destRel);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
  await rm(path.join(tmpDir(), `${side.uploadId}.json`), { force: true }).catch(() => undefined);
  return { path: destRel, width: side.width, height: side.height };
}
