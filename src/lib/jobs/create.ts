import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { estimateCostUsd, estimateHarnessCostUsd, type ImagePricingHint } from "@/lib/cost";
import { reserveJobFunds } from "@/lib/billing/admission";
import { priceCny } from "@/lib/billing/prices";
import { packHarnessDuration } from "@/lib/harness/pack-duration";
import { harnessEnabled, maxQueuedJobs, maxQueuedJobsPerUser } from "@/lib/env";
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
import { activeCountForUser } from "@/lib/jobs/active";
import { withAdmissionLock } from "@/lib/jobs/admission";
import {
  idempotencyRequestHash,
  lookupIdempotency,
  saveIdempotency,
} from "@/lib/jobs/idempotency";
import { assertQuota } from "@/lib/jobs/quota";
import { activeCount, enqueue } from "@/lib/jobs/runner";
import { assertCreateJobFields } from "@/lib/jobs/request-validation";
import { resolveLocalOutput } from "@/lib/jobs/local-output";
import { purgedBlock, retryBlock } from "@/lib/jobs/retry-guard";
import { readJob, tmpDir, toPublic, writeJob } from "@/lib/jobs/store";
import { isHarnessDuration, isImageMode } from "@/lib/providers/grok/mode-matrix";
import { imageConfigFor } from "@/lib/providers/openai-image/config";
import {
  mapAspectToSize as mapOpenaiImageSize,
  mapQuality as mapOpenaiImageQuality,
} from "@/lib/providers/openai-image/rest-map";
import { providerForId } from "@/lib/providers/router";
import { isProductAvailable, productById } from "@/lib/products/catalog";
import { chooseProduct, labelProduct } from "@/lib/jobs/product-choice";
import { mediaStore } from "@/lib/storage/local-fs";

/**
 * `ownerId` comes from the session (`requireUser`), never from the request
 * body — a client must not be able to name the account a job is filed under.
 */
export async function createJob(body: CreateJobBody, ownerId: string) {
  return withAdmissionLock(() => createJobUnlocked(body, ownerId));
}

/**
 * 队列准入：先全站、再按人（方案 §3.2「安全收口」）。
 *
 * 两条上限管的是两件事。全站的 `MAX_QUEUED_JOBS` 是实例的承载力；按人的
 * `MAX_QUEUED_JOBS_PER_USER` 是公平与防刷——没有它，一个账号可以把 20 个槽全占满，
 * 其他人只会看到「队列已满」，而余额那条闸门对此无能为力（他钱够）。
 *
 * 顺序是先全站后按人：实例本来就满了的时候，说「你有 3 条在跑」是误导。
 *
 * 必须在 `withAdmissionLock` 里调用（`createJob` / `retryJob` 都已在锁内）：在途数是
 * 从 job.json 现算的，出了锁，五个并发请求会读到同一份「还差一条到上限」。
 */
async function assertQueueRoom(ownerId: string): Promise<void> {
  const n = await activeCount();
  if (n >= maxQueuedJobs()) {
    throw new ProviderHttpError(429, "queue_full", "队列已满，请等待进行中的任务完成");
  }
  const mine = await activeCountForUser(ownerId);
  if (mine >= maxQueuedJobsPerUser()) {
    throw new ProviderHttpError(429, "queue_full", `你有 ${mine} 条任务进行中，请等待完成`);
  }
}

async function createJobUnlocked(body: CreateJobBody, ownerId: string) {
  // 同 key 异参的判据（R07）：请求体剔掉 key 之后的正则哈希，随 `idempotency.key`
  // 一起落进 job.json——重放必须带着和第一次完全相同的参数回来。
  const requestHash = body.idempotencyKey ? idempotencyRequestHash(body) : undefined;
  if (body.idempotencyKey) {
    const existing = await lookupIdempotency(ownerId, body.idempotencyKey);
    if (existing) {
      const rec = await readJob(existing);
      // The owner-namespaced filename should already make a cross-user hit
      // impossible; re-checking the record keeps that true even if a stale or
      // hand-edited mapping file points somewhere else (plan §5.2).
      if (rec && rec.ownerId === ownerId) {
        // 同 key 不同参数不是重放：沉默地交回旧任务等于「我改了提示词，出来的还是
        // 上一条」——用户会以为新请求丢了。冲突要显式报出来，让前端重取 key。
        // 老记录没有 `idempotency` 字段（那时幂等只写在映射文件里），无从比对，
        // 按归属沿用旧语义放行。
        const storedHash = rec.idempotency?.requestHash;
        if (storedHash && storedHash !== requestHash) {
          throw new ProviderHttpError(
            409,
            "idempotency_conflict",
            "同一幂等键被用于不同的请求参数，请重新发起",
          );
        }
        return { job: toPublic(rec), replay: true };
      }
    }
  }

  assertCreateJobFields(body);

  await assertQueueRoom(ownerId);
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

  // 画幅、分辨率、尾帧一起交给路由 / 产品校验：接不下的 provider 不该被选中（选中了
  // 只会把竖屏悄悄换成横屏、把 1080p 降成 720p，或者被上游 400）。没有一家接得下时
  // `chooseProduct` 自己抛 400。用户点名了产品（`body.model` 是产品 id）时绕过 ORDER。
  const choice = chooseProduct({
    mode,
    requestedId: body.model,
    harness,
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    imageResolution: image ? (body.imageResolution ?? "1k") : undefined,
    needsLastFrame: Boolean(last),
    referenceCount: refs.length,
    durationSec,
  });
  const provider = choice.provider;
  const model = modelForProvider(provider, mode, choice.product);
  const product = labelProduct(choice, mode, model);
  const providerImpl = providerForId(provider);
  const caps = providerImpl.capabilities();
  // 尾帧只有声明 `supportsLastFrameLock` 的 provider 发得出去（当前只有可灵，且强制 1080p）。
  // 路由已经按这条挑过人，这里兜住「用户点名了一个发不了的产品」与 mock 之外的漏网。
  if (last && !caps.supportsLastFrameLock) {
    throw new ProviderHttpError(400, "invalid_argument", "当前模型不支持首尾帧");
  }
  if (caps.maxReferenceImages != null && refs.length > caps.maxReferenceImages) {
    throw new ProviderHttpError(
      400,
      "invalid_argument",
      caps.maxReferenceImages > 0
        ? `所选模型最多支持 ${caps.maxReferenceImages} 张参考图`
        : "所选模型不支持参考图",
    );
  }
  // 每家上游各有各的枚举（可灵只收 5 / 10 秒；YMan 按模型有 5/10/15 或 10/15 的档）。
  // 归一后的值要写回记录：4 秒的请求上游按 5 秒计费，账目与详情卡都得是「会被计费的
  // 那个值」（方案 §4）。带尾帧时可灵会把分辨率抬到 1080p，售价也按抬完的档算。
  const settings = providerSettingsFor(provider, mode, durationSec, body, model, {
    // 只有用户**点名**的产品才参与归一（`choice.product`）。没点名时 `product` 只是按
    // provider 打上的标签，让它去决定默认分辨率 / 音轨，等于让一张产品表悄悄推翻
    // `KLING_VIDEO_AUDIO` 这类实例配置——那不是用户的选择，也不该改变他被收的钱。
    product: choice.product,
    hasLastFrame: Boolean(last),
  });
  // provider 自己的约束（grok 的参考图 7 张、源视频必须 file_id、尾帧一律拒绝）。
  // 通用的请求体校验在上面的 `assertCreateJobFields`，与 provider 无关。
  providerImpl.validate?.({
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
    product: product?.id,
    productName: product?.name,
    prompt: body.prompt,
    durationSec: dur,
    aspectRatio:
      mode === "edit_video" || mode === "extend_video"
        ? null
        : (settings?.ratio ?? body.aspectRatio ?? "16:9"),
    resolution,
    imageResolution,
    generateAudio,
    // 请求体里的标签已由 `tagsSchema` trim / 去重 / 判过上限，这里原样落盘。
    tags: body.tags,
    lastFrameStored: Boolean(last),
    // 真的把尾帧发给了上游、成片最后一帧真会是它，才算「锁住尾帧」：当前只有可灵这条
    // 通道会发（其余 provider 只落盘，grok 的 rest-map 甚至会拒绝带尾帧的请求体），
    // mock 更是只出一段占位片。记成 true 却没锁，就是按锁了收钱。
    lastFrameLocksOutput: provider === "kling" && Boolean(last),
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
    // 幂等键跟着任务记录走（事实源）：映射文件丢了也能从 job.json 重建回来（R07）。
    ...(body.idempotencyKey && requestHash
      ? { idempotency: { key: body.idempotencyKey, requestHash } }
      : {}),
  };

  // 余额是主闸门（方案 §3.2），配额退居防滥用兜底。判定与下面的 `writeJob` 必须在
  // 同一个 `withAdmissionLock` 临界区里：只有那次写盘落地后，这条任务的预留才对
  // 下一个请求可见。放在认领素材之前，被拒时磁盘上不留半个任务目录。
  // 预留的分池分配额在这一刻冻结（A 包）：会员池 earmark 从此被这条任务钉住。
  rec.reservation = await reserveJobFunds(ownerId, rec.priceCny);

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
  await assertQueueRoom(ownerId);
  // A retry issues a brand-new billable upstream request, so it spends a slot exactly like a
  // first submission — same judge, same lock (plan §6.2).
  await assertQuota(ownerId, source.mode);

  const id = `job_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  // Re-resolving both together keeps a retry from pairing a stale model name with a provider
  // the current environment would now pick (e.g. an OpenAI key added since the first attempt).
  const harness = Boolean(source.harness?.enabled);
  // 画幅、分辨率、尾帧同样参与路由：重试不该把源任务的竖屏悄悄换成另一家的默认横屏，
  // 也不该把 1080p 降成 720p。没有一家接得下时抛 400——这条路径上它的意思是「这个
  // 组合现在没人做了」，比出一个别的东西诚实。
  //
  // 产品沿用源任务：用户当初点的是「标准」，重试出来的也该是「标准」。那个产品现在
  // 不可用（下架、耗尽、换了配置）时 `chooseProduct` 会 400，所以先自己判一次可用性，
  // 不可用就退回默认路由——重试本来就是一次全新的下单，回落比整个拒绝有用。
  // 长片不带产品重新下单：它恒定留在 xAI 的一致性管线，源任务上的标签（可能是 mock
  // 实例随手打的）不该让重试卡在「所选模型不支持长片」上。
  const sourceProduct = harness ? undefined : productById(source.product);
  const keepProduct = sourceProduct && isProductAvailable(sourceProduct) ? sourceProduct : undefined;
  const choice = chooseProduct({
    mode: source.mode,
    requestedId: keepProduct?.id,
    harness,
    aspectRatio: source.aspectRatio ?? undefined,
    resolution: source.resolution ?? undefined,
    imageResolution: source.imageResolution ?? undefined,
    needsLastFrame: Boolean(source.assets.last),
    referenceCount: source.assets.references?.length ?? 0,
    durationSec: source.durationSec,
  });
  const provider = choice.provider;
  const model = modelForProvider(provider, source.mode, choice.product);
  const product = labelProduct(choice, source.mode, model);
  // 源任务可能是 grok 时代的 6 秒片：换了 provider 后同样要归一，否则重试会照着一个上游
  // 根本不收的时长下单，账目也还是旧 provider 的估价。
  const settings = providerSettingsFor(
    provider,
    source.mode,
    source.durationSec,
    {
      prompt: source.prompt,
      aspectRatio: source.aspectRatio ?? undefined,
      resolution: source.resolution ?? undefined,
      generateAudio: source.generateAudio,
    },
    model,
    // 同 `createJob`：只有当初被点名、这次仍沿用的那个产品参与归一。
    { product: choice.product, hasLastFrame: Boolean(source.assets.last) },
  );
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
    product: product?.id,
    productName: product?.name,
    prompt: source.prompt,
    durationSec,
    aspectRatio: settings?.ratio ?? source.aspectRatio,
    resolution,
    imageResolution,
    generateAudio,
    // 重试出来的还是「同一件作品的另一次尝试」，源任务的标签跟着走，不用重新贴。
    tags: source.tags,
    lastFrameStored: source.lastFrameStored,
    // 同 `createJob`：重试可能换了 provider，锁没锁尾帧要按**这次**的落点算。
    lastFrameLocksOutput: provider === "kling" && Boolean(source.assets.last),
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

  // 同一个判官、同一把锁（方案 §3.2）：重试和首次提交花的是一样的钱——
  // 也一样在准入这一刻冻结自己的分池预留。
  rec.reservation = await reserveJobFunds(ownerId, rec.priceCny);

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
