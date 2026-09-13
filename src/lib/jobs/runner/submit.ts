import path from "node:path";
import { JOB_UNCERTAIN_SUBMIT_MESSAGE, UNCERTAIN_SUBMIT_CODE } from "@/lib/jobs/retry-guard";
import type { JobRecord } from "@/lib/jobs/schema";
import { readJob, updateJob } from "@/lib/jobs/store";
import { log } from "@/lib/log";
import { deleteXaiFile, uploadXaiFile } from "@/lib/providers/grok/client";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import { recordOutcome } from "@/lib/providers/health";
import { isAmbiguousSubmitError } from "@/lib/providers/rejection";
import { needsSourceFileUpload, providerForId } from "@/lib/providers/router";
import {
  ProviderHttpError,
  type MediaRef,
  type ProviderGenerateRequest,
} from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { pathRef } from "./persist";
import { emitRec, fail, removeLocalOutput } from "./state";

export async function submit(job: JobRecord) {
  const provider = providerForId(job.provider);

  if (needsSourceFileUpload(provider.id, job.mode) && job.assets.source) {
    const abs = path.join(mediaStore.jobDir(job.id), job.assets.source.path);
    let uploadedFileId: string | undefined;
    try {
      const fileId = await uploadXaiFile(abs, "source.mp4");
      uploadedFileId = fileId;
      const afterUpload = await readJob(job.id);
      if (!afterUpload || afterUpload.status === "canceled" || afterUpload.canceled) {
        await deleteXaiFile(fileId);
        uploadedFileId = undefined;
        return;
      }
      await updateJob(job.id, (r) => {
        if (r.status === "canceled" || r.canceled) return r;
        if (r.assets.source) r.assets.source.xaiFileId = fileId;
        return r;
      });
      const afterClaim = await readJob(job.id);
      if (!afterClaim || afterClaim.status === "canceled" || afterClaim.canceled) {
        await deleteXaiFile(fileId);
        uploadedFileId = undefined;
        return;
      }
      job = afterClaim;
    } catch (e) {
      if (uploadedFileId) await deleteXaiFile(uploadedFileId);
      if (e instanceof ProviderHttpError) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      log("error", "source video Files upload failed", { id: job.id, detail });
      throw new Error("源视频上传失败，请重试");
    }
  }

  const beforeProvider = await readJob(job.id);
  if (!beforeProvider || beforeProvider.status === "canceled" || beforeProvider.canceled) {
    if (job.assets.source?.xaiFileId) await deleteXaiFile(job.assets.source.xaiFileId);
    return;
  }
  job = beforeProvider;
  const req = toProviderReq(job);
  const submitStarted = Date.now();
  const handle = await provider.submit(req);
  // 提交被受理 = 这家这通道此刻是活的：清掉冷却 / 连击计数（健康窗口只记样本）。
  recordOutcome(provider.id, isImageMode(job.mode) ? "image" : "video", true, Date.now() - submitStarted);
  const afterProvider = await readJob(job.id);
  if (!afterProvider || afterProvider.status === "canceled" || afterProvider.canceled) {
    await removeLocalOutput(job.id, handle.localVideoPath);
    if (afterProvider?.assets.source?.xaiFileId) {
      await deleteXaiFile(afterProvider.assets.source.xaiFileId);
    }
    return;
  }
  if (handle.respectModeration === false) {
    await removeLocalOutput(job.id, handle.localVideoPath);
    await fail(job.id, "moderation", "未通过安全审核");
    return;
  }
  await updateJob(job.id, (r) => {
    if (r.status === "canceled" || r.canceled) return r;
    r.remoteId = handle.remoteId ?? job.id;
    r.fileOutputId = handle.fileOutputId ?? r.fileOutputId;
    r.localOutputPath = handle.localVideoPath;
    // A provider that stages the file itself (OpenAI images) reports its charge on the same
    // handle; booking the cost only in the remoteUrl branch would drop it silently.
    r.costUsdActual = handle.costUsdActual ?? r.costUsdActual;
    if (handle.remoteUrl) {
      delete r.localOutputPath;
      r.remoteUrl = handle.remoteUrl;
      r.status = "persisting";
      r.progress = 90;
    } else if (!handle.localVideoPath) {
      r.status = "pending";
      r.progress = 5;
    } else {
      r.status = "persisting";
      r.progress = 90;
    }
    return r;
  }).then(emitRec);
}

export function toProviderReq(job: JobRecord): ProviderGenerateRequest {
  const start = job.assets.start
    ? pathRef(job.id, job.assets.start.path)
    : undefined;
  // 尾帧只发给声明 `supportsLastFrameLock` 的 provider。发不了的那几家里，grok 的
  // `assertModeConstraints` 会对带尾帧的请求体直接 400——一条 kling 之前落盘过尾帧的
  // 老任务（那时尾帧只存不发）重试到 grok 就会永远失败，而它本来该照常出片、忽略尾帧。
  const lastImage =
    job.assets.last && providerForId(job.provider).capabilities().supportsLastFrameLock
      ? pathRef(job.id, job.assets.last.path)
      : undefined;
  const refs = job.assets.references?.map((a) => pathRef(job.id, a.path));
  let source: MediaRef | undefined;
  if (job.assets.source?.xaiFileId) {
    source = { kind: "file_id", fileId: job.assets.source.xaiFileId };
  } else if (job.assets.source) {
    source = { kind: "path", path: path.join(mediaStore.jobDir(job.id), job.assets.source.path) };
  }
  return {
    jobId: job.id,
    mode: job.mode,
    prompt: job.prompt,
    model: job.model,
    durationSec: job.mode === "edit_video" || isImageMode(job.mode) ? undefined : job.durationSec,
    aspectRatio: job.aspectRatio ?? undefined,
    resolution: job.resolution ?? undefined,
    imageResolution: job.imageResolution ?? undefined,
    generateAudio: isImageMode(job.mode) ? false : job.generateAudio,
    startImage: start,
    // 可灵在图生视频里以 `last_frame` 发送（上游强制 1080p，`create.ts` 已按这一档定价）；
    // 其余 provider 拿不到它，尾帧只留在 `inputs/last.jpg`（上面那段）。
    lastImage,
    referenceImages: refs,
    referenceAudios: job.voiceIds?.map((voiceId) => ({ voiceId })),
    sourceVideo: source,
    // Re-read job.json rather than close over a flag: "轮询是真相" applies here too —
    // the cancel route writes the record from another request, and a provider that
    // blocks for minutes has to see that write while it is still blocking.
    shouldAbort: async () => {
      const latest = await readJob(job.id);
      return !latest || latest.status === "canceled" || Boolean(latest.canceled);
    },
  };
}

/**
 * A single-clip job that crashed between `provider.submit` returning and `remoteId`
 * being written. Returns the upstream task id when the provider can prove one exists,
 * null otherwise — including when the lookup itself fails.
 *
 * Never throws: recovery runs during boot, and a flaky upstream must not keep the
 * server from starting. A failed lookup is simply "still unknown", which is the safe
 * side: the job ends up `uncertain_submit` and nothing is re-submitted.
 */
export async function lookupInterruptedSubmit(job: JobRecord): Promise<string | null> {
  try {
    const provider = providerForId(job.provider);
    if (!provider.lookupByExternalId) return null;
    return await provider.lookupByExternalId(job.id);
  } catch (error) {
    log("warn", "uncertain submit lookup failed", {
      id: job.id,
      provider: job.provider,
      msg: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 「提交结果不确定」的判定在 `@/lib/providers/rejection.ts`——那里同时给出
 * 「确定拒绝（可换家）」的反面判据，两边必须共享同一条边界，否则一个错误会
 * 同时被判成两类。
 */

/**
 * 一次「不确定」的提交该怎么结（R06）。
 *
 * - `"resumed"`：上游 `lookupByExternalId` 证明单子已经建出来了，记录已接管成
 *   `pending`——它照常计费、照常出片，调用方进轮询段把它跑完；
 * - `"handled"`：任务已结（`failed`/`uncertain_submit` 或已取消），`runOne` 直接返回；
 * - `"not-ambiguous"`：错误不属于这一类，交回调用方按普通失败走。
 */
export async function resolveAmbiguousSubmit(
  id: string,
  error: unknown,
): Promise<"resumed" | "handled" | "not-ambiguous"> {
  if (!isAmbiguousSubmitError(error)) return "not-ambiguous";
  const rec = await readJob(id);
  if (!rec || rec.canceled || rec.status === "canceled") return "handled";
  // 先走不花钱的确认路：能把我们的 jobId 当外部单号查回任务，就接管它继续轮询，
  // 而不是把一份可能已付费的单子按「失败」扔掉再重买一次。
  const remoteId = await lookupInterruptedSubmit(rec);
  if (remoteId) {
    const next = await updateJob(id, (r) => {
      if (r.status === "canceled" || r.canceled || r.status !== "submitting") return r;
      r.remoteId = remoteId;
      r.status = "pending";
      r.progress = Math.max(r.progress, 5);
      return r;
    });
    if (next.status === "pending" && next.remoteId === remoteId) {
      emitRec(next);
      log("info", "ambiguous submit resolved by upstream lookup", { id, remoteId });
      return "resumed";
    }
    return "handled";
  }
  // 查不到、provider 没这个能力、或查询本身也挂了：诚实的答案是「不知道」——标记
  // uncertain_submit，锁死一键重试（`retryBlock`），而不是把可能已付费的单子重发。
  const detail = error instanceof Error ? error.message : String(error);
  await fail(id, UNCERTAIN_SUBMIT_CODE, JOB_UNCERTAIN_SUBMIT_MESSAGE, detail);
  return "handled";
}
