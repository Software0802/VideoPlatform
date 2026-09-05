import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { estimateHarnessCostUsd } from "@/lib/cost";
import {
  harnessEnabled,
  harnessQcVisualThreshold,
  harnessShotConcurrency,
} from "@/lib/env";
import { runFfmpeg } from "@/lib/ffmpeg";
import { emitJob } from "@/lib/jobs/events";
import { commitLocalOutput, resolveLocalOutput } from "@/lib/jobs/local-output";
import type { JobRecord, JobStatus } from "@/lib/jobs/schema";
import { canTransition } from "@/lib/jobs/state-machine";
import { readJob, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { log } from "@/lib/log";
import { persistRemote } from "@/lib/media/persist";
import { deleteXaiFile, uploadXaiFile } from "@/lib/providers/grok/client";
import { isHarnessDuration } from "@/lib/providers/grok/mode-matrix";
import { providerForId } from "@/lib/providers/router";
import type { MediaRef, ProviderHandle, VideoProvider } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { createDirectorPlan, type DirectorInput } from "./director";
import { requestIdentitySheet } from "./identity-sheet";
import { persistIdentitySheet } from "./identity-sheet-store";
import { extractSharpestTailFrame } from "./keyframe";
import { applyKeyframeLocks } from "./keyframe-plan";
import { mockDirectorPlan } from "./mock-director";
import { runShotQc, ShotQcFailure } from "./qc";
import { runPersistedPlan } from "./run-persisted-plan";
import { ShotFailure } from "./shot-executor";
import type { HarnessShotRecord } from "./shot-state";
import { saveHarnessPlan, updateHarnessBible } from "./state";
import { stitchClips, StitchCanceled } from "./stitch";
import type { HarnessPlan, Shot } from "./types";
import { scoreVisualConsistency, tightenShotPrompt } from "./visual-qc";

/**
 * M2.4 — the consistency pipeline wired to the JobRunner.
 *
 *   queued → directing (Director plan + keyframe locks, saved once)
 *          → keyframing (character sheets for R2V shots)
 *          → generating_shots (per-shot submit/poll/persist + technical/visual QC, ≤2 retries)
 *          → qc (aggregate verification + cost guard)
 *          → stitching (ffmpeg hard-cut concat → outputs/video.mp4)
 *          → persisting (handed back to the runner: poster, probe, succeeded)
 *
 * Every stage is resumable: the plan and shot records live in job.json, so a
 * restart re-enters execute() at the current status and skips finished work.
 */

export interface HarnessOrchestrator {
  execute(jobId: string): Promise<void>;
}

export class HarnessFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessFailure";
  }
}

export type HarnessDeps = {
  enabled: () => boolean;
  provider?: VideoProvider;
  director?: (input: DirectorInput, job: JobRecord) => Promise<HarnessPlan> | HarnessPlan;
  visualThreshold: () => number | null;
  visualScorer: typeof scoreVisualConsistency;
  shotConcurrency: () => number;
  pollIntervalMs?: number;
  stitchSize?: (job: JobRecord) => { width: number; height: number };
  /** Job cost may grow to estimate × this before retries stop (design.md §7.2 H4). */
  budgetMultiplier: number;
};

const DEFAULT_DEPS: HarnessDeps = {
  enabled: harnessEnabled,
  visualThreshold: harnessQcVisualThreshold,
  visualScorer: scoreVisualConsistency,
  shotConcurrency: harnessShotConcurrency,
  budgetMultiplier: 2,
};

const PROGRESS = {
  directing: 2,
  keyframing: 6,
  shotsStart: 10,
  shotsEnd: 78,
  qc: 82,
  stitching: 86,
  persisting: 92,
} as const;

export function createHarnessOrchestrator(overrides: Partial<HarnessDeps> = {}): HarnessOrchestrator {
  const deps: HarnessDeps = { ...DEFAULT_DEPS, ...overrides };

  async function execute(jobId: string): Promise<void> {
    if (!deps.enabled()) throw new Error("HARNESS_NOT_ENABLED");
    let job = await readJob(jobId);
    if (!job) throw new Error("job not found");
    if (isCanceledRecord(job)) return;
    if (!isHarnessDuration(job.durationSec)) {
      throw new HarnessFailure("invalid_argument", "只有 30 / 45 / 60 秒任务走一致性管线");
    }

    if (job.status === "queued") job = await setStatus(jobId, "directing", PROGRESS.directing);
    if (job.status === "directing") {
      await direct(job);
      job = await setStatus(jobId, "keyframing", PROGRESS.keyframing);
    }
    if (job.status === "keyframing") {
      await keyframe(job);
      job = await setStatus(jobId, "generating_shots", PROGRESS.shotsStart);
    }
    if (job.status === "generating_shots") {
      const outcome = await generateShots(job);
      if (outcome === "canceled") return;
      job = await setStatus(jobId, "qc", PROGRESS.qc);
    }
    if (job.status === "qc") {
      await verifyShots(job);
      job = await setStatus(jobId, "stitching", PROGRESS.stitching);
    }
    if (job.status === "stitching") {
      const done = await stitch(job);
      if (!done) return;
    }
  }

  /* ── L1 Director ── */

  async function direct(job: JobRecord) {
    if (job.harnessPlan && job.harnessShots) return;
    const input: DirectorInput = {
      prompt: job.prompt.trim() || "以首帧图为起点，延续画面的空间、光线与主体。",
      targetDurationSec: job.durationSec as 30 | 45 | 60,
      language: /[㐀-鿿]/.test(job.prompt) || !job.prompt.trim() ? "zh" : "en",
      hasStartFrame: Boolean(job.assets.start),
      hasLastFrame: Boolean(job.assets.last),
      referenceAssetIds: job.assets.references?.map((a) => a.path) ?? [],
    };
    const raw = deps.director
      ? await deps.director(input, job)
      : job.provider === "mock"
        ? mockDirectorPlan(input)
        : await createDirectorPlan(input);
    const plan = lockPlan(raw, job);
    await saveHarnessPlan(job.id, plan);
    const estimate = estimateHarnessCostUsd(plan.packing.clips);
    await updateJob(job.id, (r) => {
      r.costUsdEstimate = estimate;
      r.harness = { enabled: true };
      return r;
    });
    log("info", "harness plan saved", {
      id: job.id,
      shots: plan.shots.length,
      clips: plan.packing.clips.map((c) => `${c.kind}:${c.durationSec}`),
      estimate,
    });
  }

  /* ── L2 Keyframe: character sheets for reference-driven shots ── */

  async function keyframe(job: JobRecord) {
    const plan = job.harnessPlan;
    if (!plan) throw new Error("Harness 状态不存在");
    const needsSheet = new Set(
      plan.shots.filter((s) => s.route === "grok_r2v").flatMap((s) => s.characterIds),
    );
    const provider = deps.provider ?? providerForId(job.provider);
    const jobDir = mediaStore.jobDir(job.id);
    for (const character of plan.bible.characters) {
      if (!needsSheet.has(character.id) || character.sheetAssetIds.length) continue;
      if (await isCanceled(job.id)) return;
      const result = await requestIdentitySheet(
        { jobId: job.id, bible: plan.bible, characterId: character.id },
        provider,
      );
      const handle = await materializeLocalHandle(result.requestJobId, result.handle);
      const saved = await persistIdentitySheet(
        { ...result, handle },
        { jobDir, tempDir: tmpDir(), isCanceled: () => isCanceled(job.id) },
      );
      await rm(mediaStore.jobDir(result.requestJobId), { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (!saved) return;
      await updateHarnessBible(job.id, (bible) => ({
        ...bible,
        characters: bible.characters.map((c) =>
          c.id === character.id ? { ...c, sheetAssetIds: [saved.assetId] } : c,
        ),
      }));
      if (saved.costUsdActual) await addActualCost(job.id, saved.costUsdActual);
    }
  }

  /* ── L3–L5 Shots + QC ── */

  async function generateShots(job: JobRecord): Promise<"done" | "canceled"> {
    const plan = job.harnessPlan;
    if (!plan || !job.harnessShots) throw new Error("Harness 状态不存在");
    const provider = deps.provider ?? providerForId(job.provider);
    const jobDir = mediaStore.jobDir(job.id);
    const uploadedFiles = new Map<string, string>();
    const total = plan.shots.length;
    // Sheet generation cost was booked before any shot ran; shots re-sum from their records.
    const sheetCost = Math.max(0, (job.costUsdActual ?? 0) - sumShotCost(job.harnessShots));

    const final = await runPersistedPlan(job.id, {
      maxParallel: deps.shotConcurrency(),
      provider,
      pollIntervalMs: deps.pollIntervalMs,
      aspectRatio: job.aspectRatio ?? undefined,
      resolution: job.resolution ?? undefined,
      resolveAsset: (assetId) => ({ kind: "path", path: resolveLocalOutput(jobDir, assetId) }),
      isCanceled: () => isCanceled(job.id),
      shotOverride: (shot, record) =>
        record.retries > 0 ? { ...shot, prompt: tightenShotPrompt(shot, plan.bible, record.retries) } : shot,
      beforeShot: async (shot, record) => {
        await assertBudget(job.id, record);
        if (shot.startFrame?.source === "extracted") {
          const previous = previousShotOutput(plan, job.id, shot);
          const tail = resolveLocalOutput(jobDir, shot.startFrame.assetId);
          await extractSharpestTailFrame(await previous, tail);
        }
      },
      sourceVideoFor: async (shot) => {
        if (shot.route !== "grok_extend") return undefined;
        const previous = await previousShotOutput(plan, job.id, shot);
        if (provider.id !== "grok") {
          throw new ShotFailure("invalid_argument", "当前 provider 不支持 extend shot");
        }
        const fileId = await uploadXaiFile(previous, `${job.id}-shot-${shot.index}-source.mp4`);
        uploadedFiles.set(shot.id, fileId);
        return { kind: "file_id", fileId } satisfies MediaRef;
      },
      cleanupHandle: async () => undefined,
      persistOutput: async (shot, handle) => {
        try {
          return await persistShot(job.id, plan, shot, handle, provider);
        } finally {
          const fileId = uploadedFiles.get(shot.id);
          if (fileId) {
            uploadedFiles.delete(shot.id);
            void deleteXaiFile(fileId);
          }
        }
      },
      cleanupOutput: async (rel) => {
        await rm(resolveLocalOutput(jobDir, rel), { force: true }).catch(() => undefined);
      },
      onState: async (record) => {
        const current = await readJob(job.id);
        if (!current?.harnessShots || isCanceledRecord(current)) return;
        const succeeded = current.harnessShots.filter((s) => s.status === "succeeded").length;
        const progress =
          PROGRESS.shotsStart + ((PROGRESS.shotsEnd - PROGRESS.shotsStart) * succeeded) / total;
        const next = await updateJob(job.id, (r) => {
          if (isCanceledRecord(r)) return r;
          r.progress = Math.max(r.progress, Math.round(progress));
          const cost = sumShotCost(r.harnessShots ?? []) + sheetCost;
          if (cost > 0) r.costUsdActual = roundUsd(cost);
          return r;
        });
        emitJob(toPublic(next));
        log("info", "harness shot", { id: job.id, shot: record.id, status: record.status, retries: record.retries });
      },
    });

    for (const fileId of uploadedFiles.values()) void deleteXaiFile(fileId);
    if (isCanceledRecord(final)) return "canceled";
    const shots = final.harnessShots ?? [];
    if (shots.some((s) => s.status === "canceled")) return "canceled";
    const blocked = shots.find((s) => s.status !== "succeeded");
    if (blocked) {
      const detail = blocked.error ? `${blocked.error.code}: ${blocked.error.message}` : blocked.status;
      throw new HarnessFailure(
        "needs_review",
        `镜头 ${blocked.index + 1}/${total} 需要人工复核（${detail}）`,
      );
    }
    return "done";
  }

  async function persistShot(
    jobId: string,
    plan: HarnessPlan,
    shot: Shot,
    handle: ProviderHandle,
    provider: VideoProvider,
  ): Promise<{ outputPath: string; qc: NonNullable<HarnessShotRecord["qc"]> }> {
    const jobDir = mediaStore.jobDir(jobId);
    const outRel = `shots/${shot.index}/video.mp4`;
    const outAbs = resolveLocalOutput(jobDir, outRel);
    await mkdir(tmpDir(), { recursive: true });
    const staged = path.join(tmpDir(), `${jobId}-shot-${shot.index}.mp4`);
    const requestJobId = `${jobId}-shot-${shot.index}`;
    try {
      if (handle.localVideoPath) {
        const src = resolveLocalOutput(mediaStore.jobDir(requestJobId), handle.localVideoPath);
        await copyFile(src, staged);
        await rm(mediaStore.jobDir(requestJobId), { recursive: true, force: true }).catch(() => undefined);
      } else {
        await persistRemote({ dest: staged, remoteUrl: handle.remoteUrl, fileId: handle.fileOutputId });
      }

      const expected =
        shot.continuity === "extend"
          ? (await previousShotDuration(plan, jobId, shot)) + shot.durationSec
          : shot.durationSec;
      let report;
      try {
        report = await runShotQc(staged, { expectedDurationSec: expected });
      } catch (error) {
        if (error instanceof ShotQcFailure) throw new ShotFailure(error.code, error.message);
        throw error;
      }
      const qc: NonNullable<HarnessShotRecord["qc"]> = {
        durationSec: report.durationSec,
        durationOk: report.durationOk,
        blackFrameFree: report.blackFrameFree,
        freezeFree: report.freezeFree,
      };

      const threshold = deps.visualThreshold();
      if (threshold != null && provider.id !== "mock") {
        const score = await visualScore(jobId, plan, shot, staged);
        qc.visualScore = score;
        if (score < threshold) {
          throw new ShotFailure("qc_visual", `视觉一致性 ${score.toFixed(2)} 低于阈值 ${threshold}`);
        }
      }

      const committed = await commitLocalOutput(staged, outAbs, () => isCanceled(jobId));
      if (!committed) return { outputPath: outRel, qc };
      return { outputPath: outRel, qc };
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
  }

  async function visualScore(jobId: string, plan: HarnessPlan, shot: Shot, clip: string): Promise<number> {
    const jobDir = mediaStore.jobDir(jobId);
    const frameDir = path.join(tmpDir(), `${jobId}-shot-${shot.index}-frames`);
    await mkdir(frameDir, { recursive: true });
    try {
      const first = path.join(frameDir, "first.jpg");
      const last = path.join(frameDir, "last.jpg");
      await runFfmpeg(["-y", "-ss", "0.05", "-i", clip, "-frames:v", "1", "-q:v", "3", first]);
      await runFfmpeg(["-y", "-sseof", "-0.2", "-i", clip, "-frames:v", "1", "-q:v", "3", "-update", "1", last]);
      const references: Array<{ label: string; dataUri: string }> = [];
      if (shot.startFrame) {
        const abs = resolveLocalOutput(jobDir, shot.startFrame.assetId);
        if (await exists(abs)) references.push({ label: "本镜起始帧", dataUri: await toDataUri(abs) });
      }
      for (const id of shot.characterIds) {
        const character = plan.bible.characters.find((c) => c.id === id);
        for (const assetId of character?.sheetAssetIds ?? []) {
          const abs = resolveLocalOutput(jobDir, assetId);
          if (await exists(abs)) references.push({ label: `${character!.name} 角色表`, dataUri: await toDataUri(abs) });
        }
      }
      const score = await deps.visualScorer({
        bible: plan.bible,
        shot,
        references,
        frames: [
          { label: "首帧", dataUri: await toDataUri(first) },
          { label: "尾帧", dataUri: await toDataUri(last) },
        ],
      });
      return score.overall;
    } finally {
      await rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function assertBudget(jobId: string, record: HarnessShotRecord) {
    if (record.retries === 0) return;
    const current = await readJob(jobId);
    if (!current) return;
    const spent = current.costUsdActual ?? 0;
    const cap = current.costUsdEstimate * deps.budgetMultiplier;
    if (spent > cap) {
      throw new HarnessFailure(
        "budget_exceeded",
        `实际成本 $${spent.toFixed(2)} 已超过预估 ×${deps.budgetMultiplier}（$${cap.toFixed(2)}），停止重试，转人工复核`,
      );
    }
  }

  /* ── L5 aggregate QC ── */

  async function verifyShots(job: JobRecord) {
    const plan = job.harnessPlan;
    const shots = job.harnessShots;
    if (!plan || !shots) throw new Error("Harness 状态不存在");
    const jobDir = mediaStore.jobDir(job.id);
    for (const record of shots) {
      if (record.status !== "succeeded" || !record.outputPath) {
        throw new HarnessFailure("qc_failed", `镜头 ${record.index + 1} 未完成`);
      }
      if (!(await exists(resolveLocalOutput(jobDir, record.outputPath)))) {
        throw new HarnessFailure("qc_failed", `镜头 ${record.index + 1} 成片缺失`);
      }
      if (record.qc && !(record.qc.durationOk && record.qc.blackFrameFree && record.qc.freezeFree)) {
        throw new HarnessFailure("qc_failed", `镜头 ${record.index + 1} 未通过质检`);
      }
    }
    const spent = job.costUsdActual ?? 0;
    if (spent > job.costUsdEstimate * deps.budgetMultiplier) {
      throw new HarnessFailure("budget_exceeded", `实际成本 $${spent.toFixed(2)} 超过预估 ×${deps.budgetMultiplier}`);
    }
  }

  /* ── L6 Stitch ── */

  async function stitch(job: JobRecord): Promise<boolean> {
    const plan = job.harnessPlan;
    const shots = job.harnessShots;
    if (!plan || !shots) throw new Error("Harness 状态不存在");
    const jobDir = mediaStore.jobDir(job.id);
    const clips = stitchOrder(plan, shots).map((rel) => resolveLocalOutput(jobDir, rel));
    const size = deps.stitchSize?.(job) ?? stitchDimensions(job.aspectRatio, job.resolution);
    const outputPath = resolveLocalOutput(jobDir, "outputs/video.mp4");
    const workDir = path.join(tmpDir(), `${job.id}-stitch`);
    try {
      await stitchClips({
        clips,
        outputPath,
        workDir,
        transition: plan.stitch.transition,
        settleLastFrame: plan.stitch.settleLastFrame,
        width: size.width,
        height: size.height,
        isCanceled: () => isCanceled(job.id),
      });
    } catch (error) {
      if (error instanceof StitchCanceled) return false;
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const next = await updateJob(job.id, (r) => {
      if (isCanceledRecord(r)) return r;
      r.status = "persisting";
      r.progress = PROGRESS.persisting;
      r.localOutputPath = "outputs/video.mp4";
      return r;
    });
    if (isCanceledRecord(next)) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      return false;
    }
    emitJob(toPublic(next));
    return true;
  }

  return { execute };
}

export const harnessOrchestrator: HarnessOrchestrator = createHarnessOrchestrator();

/* ── plan normalization ── */

/**
 * Apply user frames, tail-chain extraction targets, and route sanity to a
 * Director plan so every shot can be built by shot-router at submit time.
 */
export function lockPlan(raw: HarnessPlan, job: Pick<JobRecord, "assets">): HarnessPlan {
  const startId = job.assets.start?.path;
  const lastId = job.assets.last?.path;
  const shots: Shot[] = raw.shots.map((shot) => {
    const next: Shot = { ...shot };
    // Only frames this pipeline can materialize survive: the user start frame
    // on shot 0, and extracted tail frames that keyframe locks assign below.
    if (next.startFrame && !(next.startFrame.source === "user" && next.index === 0 && startId)) {
      delete next.startFrame;
    } else if (next.startFrame && startId) {
      next.startFrame = { source: "user", assetId: startId };
    }
    if (next.endFrame) delete next.endFrame;
    if (next.index === 0 && next.continuity === "tail_chain") next.continuity = "hard_cut";
    if (next.continuity === "tail_chain" && next.route === "grok_t2v") next.route = "grok_i2v";
    return next;
  });
  const extractedTailFrames: Record<string, string> = {};
  for (const shot of shots) {
    if (shot.continuity === "tail_chain" && shot.index > 0 && shot.startFrame?.source !== "user") {
      extractedTailFrames[String(shot.index - 1)] = `shots/${shot.index - 1}/tail.jpg`;
    }
  }
  const locked = applyKeyframeLocks(
    { ...raw, shots },
    { userStartAssetId: startId, userLastAssetId: lastId, extractedTailFrames },
  );
  return {
    ...locked,
    shots: locked.shots.map((shot) =>
      shot.startFrame && shot.route === "grok_t2v" ? { ...shot, route: "grok_i2v" } : shot,
    ),
  };
}

/** Extend outputs already contain their source, so each extend replaces the clip it grew from. */
export function stitchOrder(plan: HarnessPlan, shots: readonly HarnessShotRecord[]): string[] {
  const byId = new Map(shots.map((s) => [s.id, s]));
  const order: string[] = [];
  for (const shot of [...plan.shots].sort((a, b) => a.index - b.index)) {
    const record = byId.get(shot.id);
    if (!record?.outputPath) throw new HarnessFailure("qc_failed", `镜头 ${shot.index + 1} 成片缺失`);
    if (shot.continuity === "extend" && order.length) order.pop();
    order.push(record.outputPath);
  }
  return order;
}

export function stitchDimensions(
  aspect: JobRecord["aspectRatio"],
  resolution: JobRecord["resolution"],
): { width: number; height: number } {
  const short = resolution === "1080p" ? 1080 : resolution === "480p" ? 480 : 720;
  const [w, h] = (aspect ?? "16:9").split(":").map(Number);
  const landscape = w >= h;
  const long = Math.round((short * Math.max(w, h)) / Math.min(w, h));
  const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
  return landscape ? { width: even(long), height: even(short) } : { width: even(short), height: even(long) };
}

/* ── helpers ── */

async function setStatus(jobId: string, to: JobStatus, progress: number): Promise<JobRecord> {
  const next = await updateJob(jobId, (r) => {
    if (isCanceledRecord(r)) return r;
    if (r.status !== to) {
      if (!canTransition(r.status, to)) throw new Error(`illegal ${r.status} -> ${to}`);
      r.status = to;
    }
    r.progress = Math.max(r.progress, progress);
    return r;
  });
  emitJob(toPublic(next));
  return next;
}

async function addActualCost(jobId: string, usd: number) {
  await updateJob(jobId, (r) => {
    r.costUsdActual = roundUsd((r.costUsdActual ?? 0) + usd);
    return r;
  });
}

async function previousShotOutput(plan: HarnessPlan, jobId: string, shot: Shot): Promise<string> {
  const previous = plan.shots.find((s) => s.index === shot.index - 1);
  const current = await readJob(jobId);
  const record = current?.harnessShots?.find((s) => s.id === previous?.id);
  if (!previous || !record?.outputPath || record.status !== "succeeded") {
    throw new ShotFailure("dependency_failed", `镜头 ${shot.index} 缺少前一镜成片`);
  }
  return resolveLocalOutput(mediaStore.jobDir(jobId), record.outputPath);
}

async function previousShotDuration(plan: HarnessPlan, jobId: string, shot: Shot): Promise<number> {
  const current = await readJob(jobId);
  const previous = plan.shots.find((s) => s.index === shot.index - 1);
  const record = current?.harnessShots?.find((s) => s.id === previous?.id);
  return record?.qc?.durationSec ?? previous?.durationSec ?? 0;
}

/** Mock providers hand back a staged local file; turn it into something persistRemote accepts. */
async function materializeLocalHandle(requestJobId: string, handle: ProviderHandle): Promise<ProviderHandle> {
  if (!handle.localVideoPath || handle.remoteUrl || handle.fileOutputId) return handle;
  const abs = resolveLocalOutput(mediaStore.jobDir(requestJobId), handle.localVideoPath);
  return { ...handle, remoteUrl: await toDataUri(abs) };
}

async function toDataUri(file: string): Promise<string> {
  const bytes = await readFile(file);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false);
}

async function isCanceled(jobId: string): Promise<boolean> {
  const current = await readJob(jobId);
  return !current || isCanceledRecord(current);
}

function isCanceledRecord(record: JobRecord): boolean {
  return record.status === "canceled" || Boolean(record.canceled);
}

function sumShotCost(shots: readonly HarnessShotRecord[]): number {
  return shots.reduce((sum, s) => sum + (s.costUsd || 0), 0);
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}
