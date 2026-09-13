import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { probeDurationSec } from "@/lib/ffmpeg";
import type { JobRecord } from "@/lib/jobs/schema";
import { readJob, tmpDir, updateJob } from "@/lib/jobs/store";
import { extractPoster } from "@/lib/media/poster";
import { persistRemote } from "@/lib/media/persist";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import type { MediaRef, ProviderId } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { commitLocalOutput, resolveLocalOutput } from "../local-output";
import { emitRec } from "./state";

export async function persist(job: JobRecord) {
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
      providerId: latest.provider,
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
    providerId: latest.provider,
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

export async function stageThenCommit(opts: {
  jobId: string;
  destRel: string;
  tmpAbs: string;
  localPath?: string;
  remoteUrl?: string;
  fileId?: string;
  /** 成片属于哪家上游；下载鉴权头按它绑定（见 `download-headers.ts`）。 */
  providerId?: ProviderId;
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
      providerId: opts.providerId,
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

export function pathRef(jobId: string, rel: string): MediaRef {
  return { kind: "path", path: path.join(mediaStore.jobDir(jobId), rel) };
}
