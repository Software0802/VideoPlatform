import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { estimateCostUsd, estimateHarnessCostUsd, type ImagePricingHint } from "@/lib/cost";
import { assertBalance } from "@/lib/billing/admission";
import { priceCny } from "@/lib/billing/prices";
import { packHarnessDuration } from "@/lib/harness/pack-duration";
import { harnessEnabled, maxQueuedJobs } from "@/lib/env";
import {
  modelForProvider,
  providerSettingsFor,
  videoPricingOf,
} from "@/lib/jobs/provider-settings";
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
import { assertQuota } from "@/lib/jobs/quota";
import { activeCount, enqueue } from "@/lib/jobs/runner";
import { assertCreateJobFields } from "@/lib/jobs/request-validation";
import { resolveLocalOutput } from "@/lib/jobs/local-output";
import { purgedBlock, retryBlock } from "@/lib/jobs/retry-guard";
import { readJob, tmpDir, toPublic, writeJob } from "@/lib/jobs/store";
import { isHarnessDuration, isImageMode } from "@/lib/providers/grok/mode-matrix";
import { assertModeConstraints } from "@/lib/providers/grok/rest-map";
import { imageConfigFor } from "@/lib/providers/openai-image/config";
import {
  mapAspectToSize as mapOpenaiImageSize,
  mapQuality as mapOpenaiImageQuality,
} from "@/lib/providers/openai-image/rest-map";
import { currentProviderId } from "@/lib/providers/router";
import { mediaStore } from "@/lib/storage/local-fs";

/**
 * `ownerId` comes from the session (`requireUser`), never from the request
 * body — a client must not be able to name the account a job is filed under.
 */
export async function createJob(body: CreateJobBody, ownerId: string) {
  return withAdmissionLock(() => createJobUnlocked(body, ownerId));
}

async function createJobUnlocked(body: CreateJobBody, ownerId: string) {
  if (body.idempotencyKey) {
    const existing = await lookupIdempotency(ownerId, body.idempotencyKey);
    if (existing) {
      const rec = await readJob(existing);
      // The owner-namespaced filename should already make a cross-user hit
      // impossible; re-checking the record keeps that true even if a stale or
      // hand-edited mapping file points somewhere else (plan §5.2).
      if (rec && rec.ownerId === ownerId) return { job: toPublic(rec), replay: true };
    }
  }

  assertCreateJobFields(body);

  const n = await activeCount();
  if (n >= maxQueuedJobs()) {
    throw new ProviderHttpError(429, "queue_full", "队列已满，请等待进行中的任务完成");
  }
  // Same critical section as the `writeJob` below (plan §6.2). The reservation this
  // admits only becomes visible to the next caller once that write lands, so the
  // check and the write must not be separated — otherwise five concurrent requests
  // all see the same last free slot. The idempotent replay above deliberately
  // returns before this point: a replay is not a new consumption.
  await assertQuota(ownerId, body.mode);

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

  const start = body.startUploadId ? await loadSidecar(body.startUploadId, "start", ownerId) : undefined;
  const last = body.lastUploadId ? await loadSidecar(body.lastUploadId, "last", ownerId) : undefined;
  const refs = body.referenceUploadIds
    ? await Promise.all(body.referenceUploadIds.map((id) => loadSidecar(id, "reference", ownerId)))
    : [];
  const source = body.sourceVideoUploadId
    ? await loadSidecar(body.sourceVideoUploadId, "source_video", ownerId)
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

  // 画幅一起交给路由：接不下这个画幅的 provider 不该被选中（选中了只会把竖屏悄悄
  // 换成横屏，或者被上游 400）。没有一家接得下时 `currentProviderId` 自己抛 400。
  const provider = currentProviderId(mode, { harness, aspectRatio: body.aspectRatio });
  const model = modelForProvider(provider, mode);
  // 每家上游各有各的枚举（可灵只收 5 / 10 秒；YMan 按模型有 5/10/15 或 10/15 的档）。
  // 归一后的值要写回记录：4 秒的请求上游按 5 秒计费，账目与详情卡都得是「会被计费的
  // 那个值」（方案 §4）。
  const settings = providerSettingsFor(provider, mode, durationSec, body, model);
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
  const dur = image
    ? 0
    : settings
      ? settings.durationSec
      : mode === "edit_video"
        ? (source?.durationSec ?? 0)
        : (durationSec ?? 8);
  // 图片单价看模型名是看不出来的（中转模型不在任何本地表里，会被估成 0）。这里预演一次
  // provider 待会真正会发的 size / quality，把它交给计价器；grok / mock 图片仍按模型单价。
  // 两条兼容通道（openai / yman）各有各的 size 映射与价目表，所以形状要按通道取。
  const imageConfig = image ? imageConfigFor(provider) : undefined;
  const imagePricing: ImagePricingHint | undefined = imageConfig
    ? {
        size: mapOpenaiImageSize(body.aspectRatio, body.imageResolution ?? "1k", imageConfig.shape())
          .size,
        quality: mapOpenaiImageQuality(body.imageResolution ?? "1k", imageConfig.shape()),
        provider,
      }
    : undefined;
  // 售价按**归一后**的参数定：可灵把 4 秒的请求按 5 秒下单，用户看到并被扣的就该是
  // 5 秒那一档，否则界面上的「本次约 ¥x」与账单永远差一档（方案 §3.2）。
  const resolution =
    mode === "edit_video" || mode === "extend_video" || image
      ? null
      : (settings?.resolution ?? body.resolution ?? "720p");
  const generateAudio = image
    ? false
    : settings
      ? settings.audio === "native"
      : (body.generateAudio ?? true);
  const imageResolution = image ? (body.imageResolution ?? "1k") : null;
  const rec: JobRecord = {
    schemaVersion: 1,
    id,
    ownerId,
    status: "queued",
    progress: 0,
    mode,
    model,
    provider,
    prompt: body.prompt,
    durationSec: dur,
    aspectRatio:
      mode === "edit_video" || mode === "extend_video"
        ? null
        : (settings?.ratio ?? body.aspectRatio ?? "16:9"),
    resolution,
    imageResolution,
    generateAudio,
    lastFrameStored: Boolean(last),
    lastFrameLocksOutput: false,
    harness: { enabled: harness },
    priceCny: priceCny({ mode, durationSec: dur, resolution, generateAudio, imageResolution }),
    costUsdEstimate: harness
      ? estimateHarnessCostUsd(packHarnessDuration(dur as 30 | 45 | 60))
      : estimateCostUsd(model, dur, imagePricing, videoPricingOf(settings, provider)),
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

  // 余额是主闸门（方案 §3.2），配额退居防滥用兜底。判定与下面的 `writeJob` 必须在
  // 同一个 `withAdmissionLock` 临界区里：预留是「在途任务的售价之和」，只有那次写盘
  // 落地后才对下一个请求可见。放在认领素材之前，被拒时磁盘上不留半个任务目录。
  await assertBalance(ownerId, rec.priceCny);

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
  if (body.idempotencyKey) await saveIdempotency(ownerId, body.idempotencyKey, id);
  enqueue(id);
  return { job: toPublic(rec), replay: false };
}

/**
 * The retry is filed under the caller, not under `source.ownerId`: the route
 * already checked the caller may see `source`, and the only case where the two
 * differ is the administrator retrying an ownerless legacy job — which should
 * then belong to the administrator rather than stay ownerless.
 */
export async function retryJob(source: JobRecord, ownerId: string): Promise<JobPublic> {
  return withAdmissionLock(() => retryJobUnlocked(source, ownerId));
}

async function retryJobUnlocked(source: JobRecord, ownerId: string): Promise<JobPublic> {
  // Before the status check: a purged job is usually `succeeded`, and answering
  // "仅失败或过期任务可重试" would send the caller looking for a status problem
  // when the real reason is that its inputs were deleted (plan §8).
  const purged = purgedBlock(source);
  if (purged) {
    throw new ProviderHttpError(409, purged.code, purged.message);
  }
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
  // A retry issues a brand-new billable upstream request, so it spends a slot exactly like a
  // first submission — same judge, same lock (plan §6.2).
  await assertQuota(ownerId, source.mode);

  const id = `job_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  // Re-resolving both together keeps a retry from pairing a stale model name with a provider
  // the current environment would now pick (e.g. an OpenAI key added since the first attempt).
  const harness = Boolean(source.harness?.enabled);
  // 画幅同样参与路由：重试不该把源任务的竖屏悄悄换成另一家的默认横屏。没有一家接得下
  // 时抛 400——这条路径上它的意思是「这个画幅现在没人做了」，比出一个别的画幅诚实。
  const provider = currentProviderId(source.mode, {
    harness,
    aspectRatio: source.aspectRatio ?? undefined,
  });
  const model = modelForProvider(provider, source.mode);
  // 源任务可能是 grok 时代的 6 秒片：换了 provider 后同样要归一，否则重试会照着一个上游
  // 根本不收的时长下单，账目也还是旧 provider 的估价。
  const settings = providerSettingsFor(provider, source.mode, source.durationSec, {
    prompt: source.prompt,
    aspectRatio: source.aspectRatio ?? undefined,
    resolution: source.resolution ?? undefined,
    generateAudio: source.generateAudio,
  }, model);
  // 重试是一次全新的、要计费的上游请求，所以按**当下**的参数重新定价，而不是抄源任务的
  // `priceCny`：源任务可能是换 provider 之前的 6 秒片，归一后时长档都变了。
  const durationSec = settings?.durationSec ?? source.durationSec;
  const resolution = settings?.resolution ?? source.resolution;
  const generateAudio = settings ? settings.audio === "native" : source.generateAudio;
  const imageResolution = source.imageResolution ?? null;
  const rec: JobRecord = {
    schemaVersion: 1,
    id,
    ownerId,
    status: "queued",
    progress: 0,
    mode: source.mode,
    model,
    provider,
    prompt: source.prompt,
    durationSec,
    aspectRatio: settings?.ratio ?? source.aspectRatio,
    resolution,
    imageResolution,
    generateAudio,
    lastFrameStored: source.lastFrameStored,
    lastFrameLocksOutput: false,
    harness: { enabled: harness },
    priceCny: priceCny({ mode: source.mode, durationSec, resolution, generateAudio, imageResolution }),
    costUsdEstimate: settings
      ? estimateCostUsd(model, settings.durationSec, undefined, videoPricingOf(settings, provider))
      : source.costUsdEstimate,
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

  // 同一个判官、同一把锁（方案 §3.2）：重试和首次提交花的是一样的钱。
  await assertBalance(ownerId, rec.priceCny);

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

async function loadSidecar(
  uploadId: string,
  expected: UploadSidecar["role"],
  ownerId: string,
): Promise<UploadSidecar> {
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
  // Someone else's upload — and an ownerless one from before the user system —
  // must be indistinguishable from a missing upload (plan §5.3): the message
  // and code stay the same so the id cannot be probed for existence. Nothing is
  // moved or deleted, so the real owner's file stays where it is.
  if (raw.ownerId !== ownerId) {
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
