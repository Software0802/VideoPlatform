import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { jobConcurrency, upstreamRetryBaseMs } from "@/lib/env";
import { HarnessFailure, harnessOrchestrator } from "@/lib/harness/orchestrator";
import { emitJob } from "@/lib/jobs/events";
import { recoverDecision } from "@/lib/jobs/recover";
import { JOB_UNCERTAIN_SUBMIT_MESSAGE, UNCERTAIN_SUBMIT_CODE } from "@/lib/jobs/retry-guard";
import { sweepRetention } from "@/lib/jobs/retention";
import { sweepIdempotency, sweepTmp } from "@/lib/jobs/sweep";
import { listJobRecords, readJob, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { extractPoster } from "@/lib/media/poster";
import { probeDurationSec } from "@/lib/ffmpeg";
import { persistRemote } from "@/lib/media/persist";
import { deleteXaiFile, uploadXaiFile } from "@/lib/providers/grok/client";
import { isHarnessDuration, isImageMode } from "@/lib/providers/grok/mode-matrix";
import { needsSourceFileUpload, providerForId } from "@/lib/providers/router";
import {
  ProviderHttpError,
  type MediaRef,
  type ProviderGenerateRequest,
  type VideoProvider,
} from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { log } from "@/lib/log";
import type { JobRecord } from "@/lib/jobs/schema";
import { canTransition } from "@/lib/jobs/state-machine";
import { cleanupJobArtifacts, commitLocalOutput, resolveLocalOutput } from "./local-output";

type RunnerState = {
  started: boolean;
  inflight: Set<string>;
  timer?: NodeJS.Timeout;
  /** Wakes `pump()` when the earliest backed-off job becomes eligible again. */
  backoffTimer?: NodeJS.Timeout;
};

function state(): RunnerState {
  const g = globalThis as typeof globalThis & { __lumenRunner?: RunnerState };
  if (!g.__lumenRunner) g.__lumenRunner = { started: false, inflight: new Set() };
  return g.__lumenRunner;
}

export async function startJobRunner() {
  const s = state();
  if (s.started) return;
  s.started = true;
  await maintenance();
  s.timer = setInterval(() => {
    void maintenance();
  }, 3600_000);
  s.timer.unref();
  await recover();
  void pump();
}

/**
 * Housekeeping on the runner's own hourly timer (plan §8): staging files and
 * idempotency replays older than a day, then the artifact retention sweep.
 *
 * Deliberately in the runner process rather than a separate cron: retention
 * rewrites `job.json` through `store.updateJob`, and doing that from a second
 * process would race the writer that owns those files.
 *
 * Each step keeps its own failures to itself, so a broken sweep cannot stop the
 * runner from starting.
 */
async function maintenance() {
  for (const step of [sweepTmp, sweepIdempotency, sweepRetention]) {
    try {
      await step();
    } catch (error) {
      log("warn", "maintenance step failed", {
        step: step.name,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function enqueue(jobId: string) {
  void jobId;
  void pump();
}

async function recover() {
  const jobs = await listJobRecords();
  const now = Date.now();
  for (const job of jobs) {
    const age = now - new Date(job.updatedAt).getTime();
    const decision = recoverDecision(job.status, age, Boolean(job.remoteId));
    if (decision === "expire") {
      await fail(job.id, "expired", "任务超时");
      continue;
    }
    if (decision === "uncertain") {
      // Last chance to turn "unknown" back into "known" without spending anything:
      // a provider that carries our job id upstream can be asked whether it already
      // has that task. Only a positive, unambiguous answer resumes the job.
      const remoteId = await lookupInterruptedSubmit(job);
      if (remoteId) {
        await updateJob(job.id, (r) => {
          if (r.status !== "submitting") return r;
          r.remoteId = remoteId;
          r.status = "pending";
          return r;
        }).then(emitRec);
        log("info", "uncertain submit resolved upstream", { id: job.id, provider: job.provider });
        continue;
      }
      await fail(job.id, UNCERTAIN_SUBMIT_CODE, JOB_UNCERTAIN_SUBMIT_MESSAGE);
      continue;
    }
    if (decision === "requeue" && job.status !== "queued") {
      await updateJob(job.id, (r) => {
        r.status = "queued";
        return r;
      });
      continue;
    }
    if (decision === "resume-pending") {
      await updateJob(job.id, (r) => {
        r.status = "pending";
        return r;
      });
    }
  }
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
async function lookupInterruptedSubmit(job: JobRecord): Promise<string | null> {
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
 * Upstream refusals that are nobody's fault and pass on their own: the account is out
 * of credit, or the platform's concurrency ceiling is full right now. Failing the job
 * outright would show "失败" for what is really "排队", and — because a submit that was
 * refused was never billed — retrying it costs nothing but time.
 */
const UPSTREAM_BACKOFF_CODES: ReadonlySet<string> = new Set(["rate_limited", "quota_exhausted"]);
const MAX_UPSTREAM_RETRIES = 3;
const UPSTREAM_BACKOFF_BASE_MS = 15_000;

/**
 * Send a refused submit back to `queued` with an exponential delay (15s / 30s / 60s),
 * or report that the budget of retries is spent so the caller can fail it.
 *
 * Returns true when the job has been dealt with (re-queued, or already canceled) and
 * `runOne` should simply return.
 */
async function backoffRequeue(id: string, error: unknown): Promise<boolean> {
  if (!(error instanceof ProviderHttpError) || !UPSTREAM_BACKOFF_CODES.has(error.code)) {
    return false;
  }
  const rec = await readJob(id);
  if (!rec) return false;
  // A cancel that landed while the refused request was in flight wins; there is
  // nothing to re-queue and nothing to fail.
  if (rec.canceled || rec.status === "canceled") return true;
  const attempts = rec.upstreamRetries ?? 0;
  if (attempts >= MAX_UPSTREAM_RETRIES) return false;
  const delayMs = UPSTREAM_BACKOFF_BASE_MS * 2 ** attempts;
  const next = await updateJob(id, (r) => {
    if (r.status === "canceled" || r.canceled) return r;
    r.status = "queued";
    r.upstreamRetries = (r.upstreamRetries ?? 0) + 1;
    r.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    return r;
  });
  emitRec(next);
  log("info", "upstream refused submit, backing off", {
    id,
    code: error.code,
    attempt: attempts + 1,
    delayMs,
  });
  return true;
}

/** User-facing wording for a refusal that survived every retry; upstream text goes to `detail`. */
function upstreamFailure(error: ProviderHttpError): { message: string; detail: string } {
  const message =
    error.code === "quota_exhausted"
      ? "平台余额不足，请联系管理员"
      : `上游繁忙，已重试 ${MAX_UPSTREAM_RETRIES} 次仍失败，请稍后再试`;
  return { message, detail: error.message };
}

/**
 * Re-arm the wake-up for backed-off jobs. Called on every pump so the timer always
 * tracks the *earliest* deadline currently on disk; `unref` keeps it from holding a
 * short-lived process (tests, scripts) open.
 */
function scheduleBackoffPump(s: RunnerState, atMs: number) {
  if (s.backoffTimer) {
    clearTimeout(s.backoffTimer);
    s.backoffTimer = undefined;
  }
  if (!Number.isFinite(atMs)) return;
  // Cap the sleep so a corrupt far-future timestamp cannot park the queue forever.
  const delay = Math.min(Math.max(atMs - Date.now(), 50), 5 * 60_000);
  s.backoffTimer = setTimeout(() => {
    s.backoffTimer = undefined;
    void pump();
  }, delay);
  s.backoffTimer.unref();
}

async function pump() {
  const s = state();
  const cap = jobConcurrency();
  if (s.inflight.size >= cap) return;
  const jobs = await listJobRecords();
  const now = Date.now();
  let earliestDeferred = Infinity;
  const queued = jobs.filter((j) => {
    if (j.status !== "queued" || s.inflight.has(j.id)) return false;
    const at = j.nextAttemptAt ? Date.parse(j.nextAttemptAt) : NaN;
    if (Number.isFinite(at) && at > now) {
      earliestDeferred = Math.min(earliestDeferred, at);
      return false;
    }
    return true;
  });
  scheduleBackoffPump(s, earliestDeferred);
  const pending = jobs.filter(
    (j) =>
      (j.status === "pending" || j.status === "persisting" || HARNESS_ACTIVE.has(j.status)) &&
      !s.inflight.has(j.id),
  );
  const next = [...pending, ...queued];
  for (const job of next) {
    if (s.inflight.size >= cap) break;
    s.inflight.add(job.id);
    void runOne(job.id).finally(() => {
      s.inflight.delete(job.id);
      void pump();
    });
  }
}

async function runOne(id: string) {
  let job = await readJob(id);
  if (!job) return;
  if (job.canceled || job.status === "canceled") return;
  try {
    if (isHarnessDuration(job.durationSec) && job.status !== "persisting") {
      // Long clips never touch a provider directly: the orchestrator owns
      // queued → … → stitching and hands the stitched file back as persisting.
      await harnessOrchestrator.execute(id);
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
      if (job.status === "persisting") await persist(job);
      return;
    }
    if (job.status === "queued") {
      job = await transition(id, "submitting");
      try {
        await submit(job);
      } catch (error) {
        // A refused submit was never billed, so it may be re-sent. Handled here rather
        // than in the catch below so "已重试 3 次" can only be said once that is true.
        if (await backoffRequeue(id, error)) return;
        if (error instanceof ProviderHttpError && UPSTREAM_BACKOFF_CODES.has(error.code)) {
          const { message, detail } = upstreamFailure(error);
          await fail(id, error.code, message, detail);
          return;
        }
        throw error;
      }
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
    }
    if (job.status === "pending" || job.status === "submitting") {
      await pollUntilDone(id);
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
    }
    if (job.status === "persisting") {
      await persist(job);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A user pressing 取消 makes the in-flight provider call throw; that is the
    // feature working, not an incident, so it must not show up in the error log.
    const canceledByUser = e instanceof ProviderHttpError && e.code === "canceled";
    log(canceledByUser ? "info" : "error", "job failed", { id, msg });
    if (msg === "HARNESS_NOT_ENABLED") {
      await fail(id, "harness", "一致性管线尚未开放");
      return;
    }
    if (e instanceof HarnessFailure) {
      await fail(id, e.code, e.message);
      return;
    }
    await fail(id, e instanceof ProviderHttpError ? e.code : "internal", msg);
  }
}

async function submit(job: JobRecord) {
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
  const handle = await provider.submit(req);
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

function toProviderReq(job: JobRecord): ProviderGenerateRequest {
  const start = job.assets.start
    ? pathRef(job.id, job.assets.start.path)
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

function pathRef(jobId: string, rel: string): MediaRef {
  return { kind: "path", path: path.join(mediaStore.jobDir(jobId), rel) };
}

async function pollUntilDone(id: string) {
  const started = Date.now();
  let transientRetries = 0;
  while (Date.now() - started < 15 * 60 * 1000) {
    const job = await readJob(id);
    if (!job || job.status === "canceled") return;
    const provider = providerForId(job.provider);
    let poll: Awaited<ReturnType<typeof provider.poll>>;
    try {
      poll = await provider.poll({
        providerId: provider.id,
        remoteId: job.remoteId,
        localVideoPath: "outputs/video.mp4",
      });
    } catch (error) {
      if (!isRetryablePollError(error) || transientRetries >= 2) throw error;
      transientRetries += 1;
      await sleep(upstreamRetryBaseMs() * 2 ** (transientRetries - 1));
      continue;
    }
    if (isRetryablePollResult(poll)) {
      if (transientRetries >= 2) {
        // Let the normal failed path preserve the upstream code/message.
      } else {
        transientRetries += 1;
        await sleep(upstreamRetryBaseMs() * 2 ** (transientRetries - 1));
        continue;
      }
    } else {
      // A successful pending response breaks a transient-error streak.
      transientRetries = 0;
    }
    const again = await readJob(id);
    if (
      !again ||
      again.status === "canceled" ||
      again.canceled ||
      ["succeeded", "failed", "expired"].includes(again.status)
    ) {
      return;
    }
    if (poll.status === "pending") {
      await updateJob(id, (r) => {
        if (r.status === "canceled" || r.canceled) return r;
        r.progress = Math.max(r.progress, poll.progress);
        r.status = "pending";
        return r;
      }).then(emitRec);
      await sleep(2000);
      continue;
    }
    if (poll.status === "expired") {
      await updateJob(id, (r) => {
        r.status = "expired";
        r.error = { code: "expired", message: "生成任务已过期" };
        return r;
      }).then(emitRec);
      return;
    }
    if (poll.status === "failed" || poll.respectModeration === false) {
      await fail(
        id,
        poll.errorCode ?? "failed",
        poll.respectModeration === false ? "未通过安全审核" : (poll.errorMessage ?? "生成失败"),
      );
      return;
    }
    await updateJob(id, (r) => {
      if (r.status === "canceled" || r.canceled) return r;
      r.status = "persisting";
      r.progress = 90;
      r.remoteUrl = poll.remoteUrl;
      r.fileOutputId = poll.fileOutputId ?? r.fileOutputId;
      r.costUsdActual = poll.usage?.costUsdActual ?? r.costUsdActual;
      return r;
    }).then(emitRec);
    return;
  }
  await fail(id, "timeout", "等待生成超时");
}

const RETRYABLE_POLL_CODES = new Set([
  "service_unavailable",
  "internal_error",
  "upstream_unavailable",
  "upstream_timeout",
]);

function isRetryablePollError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.code === "invalid_argument") return false;
  return error.status === 429 || error.status >= 500 || RETRYABLE_POLL_CODES.has(error.code);
}

function isRetryablePollResult(poll: Awaited<ReturnType<VideoProvider["poll"]>>): boolean {
  return poll.status === "failed" && Boolean(poll.errorCode && RETRYABLE_POLL_CODES.has(poll.errorCode));
}

async function persist(job: JobRecord) {
  const latest = await readJob(job.id);
  if (!latest || latest.status === "canceled" || latest.canceled) return;
  const outDir = path.join(mediaStore.jobDir(job.id), "outputs");
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpDir(), { recursive: true });

  if (isImageMode(latest.mode)) {
    const committed = await stageThenCommit({
      jobId: latest.id,
      destRel: "outputs/image.jpg",
      tmpAbs: path.join(tmpDir(), `${latest.id}-image.jpg`),
      localPath: latest.localOutputPath,
      remoteUrl: latest.remoteUrl,
      fileId: latest.fileOutputId,
    });
    if (!committed) return;
    const next = await updateJob(job.id, (r) => {
      if (r.status !== "persisting" || r.canceled) return r;
      r.status = "succeeded";
      r.progress = 100;
      r.output = {
        kind: "image",
        imageUrl: mediaStore.publicPath(r.id, "image.jpg"),
      };
      delete r.localOutputPath;
      r.error = null;
      return r;
    });
    if (next.status !== "succeeded") {
      await rm(path.join(outDir, "image.jpg"), { force: true }).catch(() => undefined);
      return;
    }
    emitRec(next);
    return;
  }

  const videoTmp = path.join(tmpDir(), `${latest.id}-video.mp4`);
  const committed = await stageThenCommit({
    jobId: latest.id,
    destRel: "outputs/video.mp4",
    tmpAbs: videoTmp,
    localPath: latest.localOutputPath,
    remoteUrl: latest.remoteUrl,
    fileId: latest.fileOutputId,
  });
  if (!committed) return;

  const posterAbs = path.join(outDir, "poster.jpg");
  const videoAbs = path.join(outDir, "video.mp4");
  try {
    await extractPoster(videoAbs, posterAbs);
  } catch {
    await copyFile(
      path.join(/*turbopackIgnore: true*/ mediaStore.jobDir(job.id), latest.assets.start?.path ?? "tmp/still.jpg"),
      posterAbs,
    ).catch(() => undefined);
  }
  let outputDurationSec = latest.durationSec;
  try {
    outputDurationSec = (await probeDurationSec(videoAbs)).durationSec;
  } catch {
    // Keep the requested duration when a provider returns a playable file
    // that ffmpeg cannot probe a second time.
  }
  const hasPoster = await access(posterAbs).then(() => true).catch(() => false);
  const canceled = await readJob(job.id);
  if (!canceled || canceled.status === "canceled" || canceled.canceled) {
    await rm(videoAbs, { force: true }).catch(() => undefined);
    await rm(posterAbs, { force: true }).catch(() => undefined);
    return;
  }
  const next = await updateJob(job.id, (r) => {
    if (r.status !== "persisting" || r.canceled) return r;
    r.status = "succeeded";
    r.progress = 100;
    r.output = {
      kind: "video",
      videoUrl: mediaStore.publicPath(r.id, "video.mp4"),
      posterUrl: hasPoster ? mediaStore.publicPath(r.id, "poster.jpg") : "",
      durationSec: outputDurationSec,
    };
    delete r.localOutputPath;
    r.error = null;
    return r;
  });
  if (next.status !== "succeeded") {
    await rm(videoAbs, { force: true }).catch(() => undefined);
    await rm(posterAbs, { force: true }).catch(() => undefined);
    return;
  }
  emitRec(next);
}

async function stageThenCommit(opts: {
  jobId: string;
  destRel: string;
  tmpAbs: string;
  localPath?: string;
  remoteUrl?: string;
  fileId?: string;
}): Promise<boolean> {
  const finalAbs = path.join(mediaStore.jobDir(opts.jobId), opts.destRel);
  const isCanceled = async () => {
    const current = await readJob(opts.jobId);
    return !current || current.status === "canceled" || Boolean(current.canceled);
  };

  if (opts.localPath) {
    const localAbs = resolveLocalOutput(mediaStore.jobDir(opts.jobId), opts.localPath);
    if (localAbs === finalAbs) {
      if (await isCanceled()) {
        await rm(finalAbs, { force: true }).catch(() => undefined);
        return false;
      }
      return true;
    }
    return commitLocalOutput(localAbs, finalAbs, isCanceled);
  }

  const hasRemote = Boolean(opts.remoteUrl || opts.fileId);
  if (hasRemote) {
    await persistRemote({
      dest: opts.tmpAbs,
      remoteUrl: opts.remoteUrl,
      fileId: opts.fileId,
    });
    return commitLocalOutput(opts.tmpAbs, finalAbs, isCanceled);
  } else {
    try {
      // Even a provider that leaves a pre-staged file should pass through the
      // same temporary path; cancellation must never expose a half-written
      // artifact in outputs/.
      await persistRemote({ dest: opts.tmpAbs });
    } catch {
      await rm(opts.tmpAbs, { force: true }).catch(() => undefined);
      throw new Error("成片不存在");
    }
    return commitLocalOutput(opts.tmpAbs, finalAbs, isCanceled);
  }
}

async function transition(id: string, to: JobRecord["status"]) {
  const rec = await updateJob(id, (r) => {
    if (!canTransition(r.status, to) && r.status !== to) {
      throw new Error(`illegal ${r.status} -> ${to}`);
    }
    r.status = to;
    return r;
  });
  emitRec(rec);
  return rec;
}

async function fail(id: string, code: string, message: string, detail?: string) {
  const rec = await readJob(id);
  if (
    !rec ||
    rec.canceled ||
    ["succeeded", "failed", "expired", "canceled"].includes(rec.status)
  ) {
    return;
  }
  if (rec?.localOutputPath) await removeLocalOutput(id, rec.localOutputPath);
  if (rec?.assets.source?.xaiFileId) {
    void deleteXaiFile(rec.assets.source.xaiFileId);
  }
  const next = await updateJob(id, (r) => {
    if (["succeeded", "failed", "expired", "canceled"].includes(r.status) || r.canceled) return r;
    r.status = code === "expired" ? "expired" : "failed";
    r.error = detail ? { code, message, detail } : { code, message };
    return r;
  });
  emitRec(next);
}

function emitRec(rec: JobRecord) {
  emitJob(toPublic(rec));
  return rec;
}

async function removeLocalOutput(jobId: string, relativePath?: string) {
  await cleanupJobArtifacts(mediaStore.jobDir(jobId), tmpDir(), jobId, relativePath);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const HARNESS_ACTIVE: ReadonlySet<JobRecord["status"]> = new Set([
  "directing",
  "keyframing",
  "generating_shots",
  "qc",
  "stitching",
]);

export async function activeCount(): Promise<number> {
  const jobs = await listJobRecords();
  return jobs.filter(
    (j) =>
      ["queued", "submitting", "pending", "persisting"].includes(j.status) ||
      HARNESS_ACTIVE.has(j.status),
  ).length;
}
