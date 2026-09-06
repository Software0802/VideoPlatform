import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { notifyAlert } from "@/lib/alerts";
import {
  estimateHarnessCostUsd,
  estimateLlmCostUsd,
  HARNESS_QC_RETRY_MULTIPLIER,
  LLM_RESERVE_USD,
  RATE_USD_PER_IMAGE,
  RATE_USD_PER_SEC,
} from "@/lib/cost";
import {
  harnessEnabled,
  harnessQcVisualThreshold,
  harnessShotConcurrency,
} from "@/lib/env";
import { runFfmpeg } from "@/lib/ffmpeg";
import { emitJob } from "@/lib/jobs/events";
import { commitLocalOutput, resolveLocalOutput } from "@/lib/jobs/local-output";
import { normalizeLlmUsage, type JobRecord, type JobStatus } from "@/lib/jobs/schema";
import { canTransition } from "@/lib/jobs/state-machine";
import { readJob, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { log } from "@/lib/log";
import { persistRemote } from "@/lib/media/persist";
import { deleteXaiFile, uploadXaiFile } from "@/lib/providers/grok/client";
import { isHarnessDuration } from "@/lib/providers/grok/mode-matrix";
import { providerForId } from "@/lib/providers/router";
import type { MediaRef, ProviderHandle, VideoProvider } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { createDirectorPlan, DIRECTOR_MODEL, type DirectorInput } from "./director";
import { requestIdentitySheet } from "./identity-sheet";
import { persistIdentitySheet } from "./identity-sheet-store";
import { extractSharpestTailFrame } from "./keyframe";
import { applyKeyframeLocks } from "./keyframe-plan";
import { mockDirectorPlan } from "./mock-director";
import type { LlmUsage } from "./llm-usage";
import { QC_DURATION_TOLERANCE_SEC, runShotQc, ShotQcFailure } from "./qc";
import { runPersistedPlan } from "./run-persisted-plan";
import { ShotFailure } from "./shot-executor";
import type { HarnessShotRecord } from "./shot-state";
import { saveHarnessPlan, updateHarnessBible } from "./state";
import { DEFAULT_SETTLE_SEC, stitchClips, StitchCanceled } from "./stitch";
import type { HarnessPlan, Shot } from "./types";
import {
  scoreVisualConsistency,
  tightenShotPrompt,
  visualQcPasses,
  VISUAL_QC_MODEL,
} from "./visual-qc";

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

/** Every paid call reports its usage back through this hook; `null` = billed, usage unknown. */
export type LlmUsageHooks = { onUsage: (usage: LlmUsage | null) => Promise<void> };

export type HarnessDeps = {
  enabled: () => boolean;
  provider?: VideoProvider;
  director?: (
    input: DirectorInput,
    job: JobRecord,
    hooks: LlmUsageHooks,
  ) => Promise<HarnessPlan> | HarnessPlan;
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

/**
 * 预算被撞破时外发一条告警（方案 §3.2「可观测性」）。
 *
 * 长片是全站最贵的一条路径，而「预算超了」意味着这一单已经花掉了提交预估的两倍、
 * 后面的调用被硬停——只写一条日志的话，往往是几天后对账才发现。按 jobId 去重：
 * 一个任务在预算线上会连撞好几次（每个分镜各来一次），吵一次就够。
 *
 * 顶层函数而不是 orchestrator 内部闭包：`createHarnessOrchestrator` 每次调用都会
 * 重建一遍内部函数，而告警与哪个实例无关。
 */
function alertBudgetExceeded(jobId: string, label: string, spentUsd: number, capUsd: number): void {
  void notifyAlert(
    "budget_exceeded",
    { jobId, stage: label, spentUsd: roundUsd(spentUsd), capUsd: roundUsd(capUsd) },
    `budget_exceeded:${jobId}`,
  );
}

/** Reservation key → USD promised to a call that has started but not settled yet. */
type Reservations = Map<string, number>;

type ReservationSpec = {
  jobId: string;
  key: string;
  amount: number;
  reserved: Reservations;
  /** Shown in the failure message so the operator knows which call hit the cap. */
  label: string;
  /** Shot callers need a terminal ShotFailure; job-level callers need a HarnessFailure. */
  fail: (detail: string) => Error;
};

function shotKey(shotId: string): string {
  return `shot:${shotId}`;
}

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

    // Money promised to calls that have started but not settled yet — Director, character
    // sheets, visual QC, shot submits. Parallel work must not each see a clean budget (R06).
    const reserved: Reservations = new Map();

    if (job.status === "queued") job = await setStatus(jobId, "directing", PROGRESS.directing);
    if (job.status === "directing") {
      await direct(job, reserved);
      job = await setStatus(jobId, "keyframing", PROGRESS.keyframing);
    }
    if (job.status === "keyframing") {
      await keyframe(job, reserved);
      job = await setStatus(jobId, "generating_shots", PROGRESS.shotsStart);
    }
    if (job.status === "generating_shots") {
      const outcome = await generateShots(job, reserved);
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

  async function direct(job: JobRecord, reserved: Reservations) {
    if (job.harnessPlan && job.harnessShots) {
      // A resumed run re-checks the saved plan: the cap must hold before any shot is (re)sent.
      guardPlannedBudget(job, estimateHarnessCostUsd(job.harnessPlan.packing.clips));
      return;
    }
    const input: DirectorInput = {
      prompt: job.prompt.trim() || "以首帧图为起点，延续画面的空间、光线与主体。",
      targetDurationSec: job.durationSec as 30 | 45 | 60,
      language: /[㐀-鿿]/.test(job.prompt) || !job.prompt.trim() ? "zh" : "en",
      hasStartFrame: Boolean(job.assets.start),
      hasLastFrame: Boolean(job.assets.last),
      referenceAssetIds: job.assets.references?.map((a) => a.path) ?? [],
    };
    const hooks: LlmUsageHooks = { onUsage: (usage) => bookLlmUsage(job.id, usage, DIRECTOR_MODEL) };
    const raw = deps.director
      ? await deps.director(input, job, hooks)
      : job.provider === "mock"
        ? // The mock Director is a local pure function: no upstream call, nothing to book.
          mockDirectorPlan(input)
        : await withReservation(
            {
              jobId: job.id,
              key: "llm:director",
              amount: LLM_RESERVE_USD.director,
              reserved,
              label: "Director 调用",
              fail: (detail) => new HarnessFailure("budget_exceeded", detail),
            },
            () => createDirectorPlan(input, hooks),
          );
    const plan = lockPlan(raw, job);
    await saveHarnessPlan(job.id, plan);
    // The submit-time estimate the user saw stays put; the plan-derived figure is stored beside it (R05).
    const planned = estimateHarnessCostUsd(plan.packing.clips);
    await updateJob(job.id, (r) => {
      r.costUsdPlanned = planned;
      r.harness = { enabled: true };
      return r;
    });
    log("info", "harness plan saved", {
      id: job.id,
      shots: plan.shots.length,
      clips: plan.packing.clips.map((c) => `${c.kind}:${c.durationSec}`),
      estimate: job.costUsdEstimate,
      planned,
    });
    guardPlannedBudget(job, planned);
  }

  /**
   * A plan that cannot fit the cap is rejected before a single shot is submitted — paying
   * for half a film and then stopping at the per-shot gate is the worst of both worlds.
   */
  function guardPlannedBudget(job: Pick<JobRecord, "id" | "costUsdEstimate">, planned: number) {
    const cap = budgetCap(job, deps.budgetMultiplier);
    if (planned <= cap) return;
    alertBudgetExceeded(job.id, "Director 计划", planned, cap);
    throw new HarnessFailure(
      "budget_exceeded",
      `Director 计划预估 $${planned.toFixed(2)} 超过预算上限 $${cap.toFixed(2)}（提交预估 $${job.costUsdEstimate.toFixed(2)} ×${deps.budgetMultiplier}），未提交任何分镜，转人工复核`,
    );
  }

  /* ── L2 Keyframe: character sheets for reference-driven shots ── */

  async function keyframe(job: JobRecord, reserved: Reservations) {
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
      // One paid image per character sheet; reserved at list price until the charge lands.
      const saved = await withReservation(
        {
          jobId: job.id,
          key: `sheet:${character.id}`,
          amount: RATE_USD_PER_IMAGE["grok-imagine-image-2.0"],
          reserved,
          label: `角色表 ${character.name}`,
          fail: (detail) => new HarnessFailure("budget_exceeded", detail),
        },
        async () => {
          const result = await requestIdentitySheet(
            { jobId: job.id, bible: plan.bible, characterId: character.id },
            provider,
          );
          const handle = await materializeLocalHandle(result.requestJobId, result.handle);
          const persisted = await persistIdentitySheet(
            { ...result, handle },
            {
              jobDir,
              tempDir: tmpDir(),
              isCanceled: () => isCanceled(job.id),
              providerId: provider.id,
            },
          );
          await rm(mediaStore.jobDir(result.requestJobId), { recursive: true, force: true }).catch(
            () => undefined,
          );
          if (persisted?.costUsdActual) await addActualCost(job.id, persisted.costUsdActual);
          return persisted;
        },
      );
      if (!saved) return;
      await updateHarnessBible(job.id, (bible) => ({
        ...bible,
        characters: bible.characters.map((c) =>
          c.id === character.id ? { ...c, sheetAssetIds: [saved.assetId] } : c,
        ),
      }));
    }
  }

  /* ── L3–L5 Shots + QC ── */

  async function generateShots(job: JobRecord, reserved: Reservations): Promise<"done" | "canceled"> {
    const plan = job.harnessPlan;
    if (!plan || !job.harnessShots) throw new Error("Harness 状态不存在");
    const provider = deps.provider ?? providerForId(job.provider);
    const jobDir = mediaStore.jobDir(job.id);
    const uploadedFiles = new Map<string, string>();
    const total = plan.shots.length;
    // Sheet cost was booked before any shot ran, and the Director's tokens before that;
    // shots and LLM calls re-sum from their own records, so isolate the sheet remainder.
    const sheetCost = Math.max(
      0,
      (job.costUsdActual ?? 0) - sumShotCost(job.harnessShots) - normalizeLlmUsage(job.llmUsage).costUsd,
    );
    // Crash-recovered shots that are already upstream never pass beforeAttempt again, so their
    // promised charge has to be put back on the reservation table before anything else submits.
    seedInFlightReservations(job.harnessShots, plan.shots, reserved);

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
      beforeAttempt: async (shot, record) => {
        await reserveShotBudget(job.id, shot, record, reserved);
      },
      beforeShot: async (shot) => {
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
          return await persistShot(job.id, plan, shot, handle, provider, reserved);
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
        if (!["submitting", "pending"].includes(record.status)) reserved.delete(shotKey(record.id));
        const current = await readJob(job.id);
        if (!current?.harnessShots || isCanceledRecord(current)) return;
        const succeeded = current.harnessShots.filter((s) => s.status === "succeeded").length;
        const progress =
          PROGRESS.shotsStart + ((PROGRESS.shotsEnd - PROGRESS.shotsStart) * succeeded) / total;
        const next = await updateJob(job.id, (r) => {
          if (isCanceledRecord(r)) return r;
          r.progress = Math.max(r.progress, Math.round(progress));
          const cost = actualCostOf(r, sheetCost);
          if (cost > 0) r.costUsdActual = cost;
          r.costIncomplete = costIsIncomplete(r, provider.id);
          markCostOverTarget(r);
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
    reserved: Reservations,
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
        await persistRemote({
          dest: staged,
          remoteUrl: handle.remoteUrl,
          fileId: handle.fileOutputId,
          providerId: provider.id,
        });
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
        const score = await visualScore(jobId, plan, shot, staged, reserved);
        qc.visualScore = Math.min(score.overall, score.identity);
        if (!visualQcPasses(score, threshold)) {
          throw new ShotFailure(
            "qc_visual",
            `视觉一致性 总分 ${score.overall.toFixed(2)} / 身份 ${score.identity.toFixed(2)} 低于阈值 ${threshold}`,
          );
        }
      }

      const committed = await commitLocalOutput(staged, outAbs, () => isCanceled(jobId));
      if (!committed) return { outputPath: outRel, qc };
      return { outputPath: outRel, qc };
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Visual QC samples first / middle / last frames of the clip and compares them with fixed
   * identity anchors (user start frame, character sheets) plus the previous shot's tail, so
   * mid-shot drift and cumulative cross-shot drift are both visible to the scorer (R07).
   * It is still a sampled check, not a per-frame one; docs/design.md §7.2 says so.
   */
  async function visualScore(
    jobId: string,
    plan: HarnessPlan,
    shot: Shot,
    clip: string,
    reserved: Reservations,
  ) {
    const jobDir = mediaStore.jobDir(jobId);
    const frameDir = path.join(tmpDir(), `${jobId}-shot-${shot.index}-frames`);
    await mkdir(frameDir, { recursive: true });
    try {
      const first = path.join(frameDir, "first.jpg");
      const middle = path.join(frameDir, "middle.jpg");
      const last = path.join(frameDir, "last.jpg");
      const midSec = Math.max(0.05, shot.durationSec / 2);
      await runFfmpeg(["-y", "-ss", "0.05", "-i", clip, "-frames:v", "1", "-q:v", "3", first]);
      await runFfmpeg(["-y", "-ss", midSec.toFixed(2), "-i", clip, "-frames:v", "1", "-q:v", "3", "-update", "1", middle]);
      await runFfmpeg(["-y", "-sseof", "-0.2", "-i", clip, "-frames:v", "1", "-q:v", "3", "-update", "1", last]);
      const references: Array<{ label: string; dataUri: string }> = [];
      const current = await readJob(jobId);
      const userStart = current?.assets.start?.path;
      if (userStart && (await exists(resolveLocalOutput(jobDir, userStart)))) {
        references.push({ label: "用户首帧（固定身份参考）", dataUri: await toDataUri(resolveLocalOutput(jobDir, userStart)) });
      }
      if (shot.startFrame && shot.startFrame.assetId !== userStart) {
        const abs = resolveLocalOutput(jobDir, shot.startFrame.assetId);
        if (await exists(abs)) references.push({ label: "本镜起始帧（上一镜尾帧）", dataUri: await toDataUri(abs) });
      }
      for (const id of shot.characterIds) {
        const character = plan.bible.characters.find((c) => c.id === id);
        for (const assetId of character?.sheetAssetIds ?? []) {
          const abs = resolveLocalOutput(jobDir, assetId);
          if (await exists(abs)) references.push({ label: `${character!.name} 角色表`, dataUri: await toDataUri(abs) });
        }
      }
      const frames = [{ label: "首帧", dataUri: await toDataUri(first) }];
      if (await exists(middle)) frames.push({ label: "中帧", dataUri: await toDataUri(middle) });
      frames.push({ label: "尾帧", dataUri: await toDataUri(last) });
      // One paid vision call per shot attempt; a terminal ShotFailure sends the shot to
      // needs_review rather than letting the retry loop buy another over-budget attempt.
      // `return await`, not `return`: the finally below awaits real I/O, and a rejected
      // promise returned without await sits handler-less until then (unhandledRejection).
      return await withReservation(
        {
          jobId,
          key: `llm:visual:${shot.id}`,
          amount: LLM_RESERVE_USD.visualQc,
          reserved,
          label: `镜头 ${shot.index + 1} 视觉质检`,
          fail: (detail) => new ShotFailure("budget_exceeded", detail, { terminal: true }),
        },
        () =>
          deps.visualScorer(
            { bible: plan.bible, shot, references, frames },
            { onUsage: (usage) => bookLlmUsage(jobId, usage, VISUAL_QC_MODEL) },
          ),
      );
    } finally {
      await rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Budget gate in front of every paid call — Director, character sheet, visual QC, shot
   * submit, retries included: spent + what other in-flight calls already promised + this
   * call's list price must stay within the cap (R06). The reservation is released by the
   * caller once the real charge is on the books.
   */
  async function reserveBudget(spec: ReservationSpec): Promise<void> {
    const current = await readJob(spec.jobId);
    if (!current) return;
    const cap = budgetCap(current, deps.budgetMultiplier);
    const spent = current.costUsdActual ?? 0;
    const others = [...spec.reserved.entries()]
      .filter(([id]) => id !== spec.key)
      .reduce((sum, [, usd]) => sum + usd, 0);
    if (spent + others + spec.amount > cap) {
      alertBudgetExceeded(spec.jobId, spec.label, spent, cap);
      throw spec.fail(
        `${spec.label}：已支出 $${spent.toFixed(2)} + 在途 $${others.toFixed(2)} + 本次预估 $${spec.amount.toFixed(2)} 超过预算上限 $${cap.toFixed(2)}（提交预估 ×${deps.budgetMultiplier}），停止调用，转人工复核`,
      );
    }
    spec.reserved.set(spec.key, spec.amount);
  }

  /** Reserve, run, release — for calls that settle inside one await (Director, sheets, visual QC). */
  async function withReservation<T>(spec: ReservationSpec, run: () => Promise<T>): Promise<T> {
    await reserveBudget(spec);
    try {
      return await run();
    } finally {
      spec.reserved.delete(spec.key);
    }
  }

  /**
   * Shots reserve across the submit/poll/persist span, so the release lives in `onState`
   * instead of a finally. Unknown charges cannot be reasoned about, so an incomplete
   * ledger also stops retries.
   */
  async function reserveShotBudget(
    jobId: string,
    shot: Shot,
    record: HarnessShotRecord,
    reserved: Reservations,
  ) {
    await reserveBudget({
      jobId,
      key: shotKey(shot.id),
      amount: shotListPrice(shot),
      reserved,
      label: `镜头 ${shot.index + 1}`,
      fail: (detail) => new ShotFailure("budget_exceeded", detail, { terminal: true }),
    });
    const current = await readJob(jobId);
    if (record.retries > 0 && current?.costIncomplete) {
      reserved.delete(shotKey(shot.id));
      throw new ShotFailure(
        "budget_unknown",
        "上游未返回本任务部分调用的费用，无法确认重试仍在预算内，转人工复核",
        { terminal: true },
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
    const cap = budgetCap(job, deps.budgetMultiplier);
    if (spent > cap) {
      alertBudgetExceeded(job.id, "总账复核", spent, cap);
      throw new HarnessFailure("budget_exceeded", `实际成本 $${spent.toFixed(2)} 超过预算上限 $${cap.toFixed(2)}`);
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
    let result;
    try {
      result = await stitchClips({
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
    // Whole-film check (R08): per-shot QC bounds each clip, this bounds their sum plus the settle.
    const film = verifyFilmDuration(result.durationSec, job.durationSec, clips.length, plan.stitch.settleLastFrame);
    await updateJob(job.id, (r) => {
      r.harnessStitch = film;
      return r;
    });
    if (!film.ok) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw new HarnessFailure(
        "qc_duration",
        `成片 ${film.durationSec.toFixed(2)}s 偏离目标 ${film.expectedSec.toFixed(2)}s（含定格 ${film.settleSec}s）超过 ±${film.toleranceSec.toFixed(1)}s`,
      );
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

/**
 * The stitched film must land on the target length: the freeze settle (only when the user
 * gave a last frame) is appended on top of the target, and each clip may drift ±0.4s, so the
 * tolerance grows with the clip count instead of pretending the sum is tighter than its parts.
 */
export function verifyFilmDuration(
  durationSec: number,
  targetSec: number,
  clipCount: number,
  settleLastFrame: boolean,
): NonNullable<JobRecord["harnessStitch"]> & { ok: boolean } {
  const settleSec = settleLastFrame ? DEFAULT_SETTLE_SEC : 0;
  const expectedSec = targetSec + settleSec;
  const toleranceSec = QC_DURATION_TOLERANCE_SEC * Math.max(1, clipCount);
  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    expectedSec,
    settleSec,
    toleranceSec,
    ok: Math.abs(durationSec - expectedSec) <= toleranceSec + 1e-6,
  };
}

/**
 * Budget cap, always relative to the estimate shown at submit time — evals/rubric.md §5
 * measures spend against that number (≤1.5 on target, ≤2.0 hard stop), so letting a
 * pricier Director plan raise its own ceiling would make the cap unfalsifiable.
 * `costUsdPlanned` is accepted for callers that pass a whole record, and ignored.
 */
export function budgetCap(
  job: Pick<JobRecord, "costUsdEstimate"> & Partial<Pick<JobRecord, "costUsdPlanned">>,
  multiplier: number,
): number {
  return job.costUsdEstimate * multiplier;
}

/** List-price estimate of one paid generation for a shot (used to reserve budget before submit). */
export function shotListPrice(shot: Pick<Shot, "route" | "durationSec">): number {
  const rate = shot.route === "grok_extend" ? RATE_USD_PER_SEC["grok-imagine-video"] : RATE_USD_PER_SEC["grok-imagine-video-1.5"];
  return roundUsd(rate * shot.durationSec);
}

/**
 * Rebuild the in-flight reservations after a restart. A shot that was `submitting` / `pending`
 * with a remote id resumes polling without going through `beforeAttempt`, so until its charge
 * lands at `persisting` nothing would count it against the cap and a concurrent shot could be
 * admitted on a budget that is already spoken for. `persisting` shots already carry their
 * charge in `costUsd` (booked with the transition), so reserving them again would double count;
 * shots without a remote id are either re-queued (and reserve normally) or escalated.
 */
export function seedInFlightReservations(
  records: readonly Pick<HarnessShotRecord, "id" | "status" | "remoteId">[],
  shots: readonly Pick<Shot, "id" | "route" | "durationSec">[],
  reserved: Map<string, number>,
): void {
  const byId = new Map(shots.map((s) => [s.id, s]));
  for (const record of records) {
    if (!record.remoteId) continue;
    if (record.status !== "pending" && record.status !== "submitting") continue;
    const shot = byId.get(record.id);
    if (shot) reserved.set(shotKey(record.id), shotListPrice(shot));
  }
}

/**
 * Mock is free; otherwise the ledger is a lower bound only when a paid call actually came
 * back without a price — an LLM call that reported usage is priced from
 * LLM_RATE_USD_PER_MTOKEN and counted, so it must not block retries (R-P1-2).
 */
export function costIsIncomplete(job: Pick<JobRecord, "harnessShots" | "llmUsage">, providerId: string): boolean {
  if (providerId === "mock") return false;
  if (normalizeLlmUsage(job.llmUsage).unpricedCalls > 0) return true;
  return (job.harnessShots ?? []).some((s) => s.costUnknown);
}

/** costUsdActual = every shot attempt + character sheets + the priced LLM calls. */
function actualCostOf(job: Pick<JobRecord, "harnessShots" | "llmUsage">, sheetCost: number): number {
  return roundUsd(
    sumShotCost(job.harnessShots ?? []) + sheetCost + normalizeLlmUsage(job.llmUsage).costUsd,
  );
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

/**
 * Book one finished LLM call. `usage === null` means the call was billed but the upstream
 * returned no token counts: it lands in `unpricedCalls`, which is what makes the whole
 * ledger a lower bound. Priced calls are converted at list price and folded into
 * `costUsdActual`, so the budget gate sees LLM spend too.
 */
async function bookLlmUsage(jobId: string, usage: LlmUsage | null, model: string) {
  await updateJob(jobId, (r) => {
    const prev = normalizeLlmUsage(r.llmUsage);
    const usd = usage ? estimateLlmCostUsd(model, usage) : 0;
    r.llmUsage = {
      calls: prev.calls + 1,
      promptTokens: prev.promptTokens + (usage?.promptTokens ?? 0),
      completionTokens: prev.completionTokens + (usage?.completionTokens ?? 0),
      unpricedCalls: prev.unpricedCalls + (usage ? 0 : 1),
      costUsd: roundMicroUsd(prev.costUsd + usd),
    };
    if (usd > 0) r.costUsdActual = roundUsd((r.costUsdActual ?? 0) + usd);
    r.costIncomplete = costIsIncomplete(r, r.provider);
    markCostOverTarget(r);
    return r;
  });
}

async function addActualCost(jobId: string, usd: number) {
  await updateJob(jobId, (r) => {
    r.costUsdActual = roundUsd((r.costUsdActual ?? 0) + usd);
    markCostOverTarget(r);
    return r;
  });
}

/**
 * Soft cost line (evals/rubric.md §5): actual spend above 1.5 × the submit-time estimate is
 * "not cost-compliant" but keeps running; the hard stop is `budgetCap` at ×2. Pure predicate.
 */
export function costOverTarget(job: Pick<JobRecord, "costUsdEstimate" | "costUsdActual">): boolean {
  return (job.costUsdActual ?? 0) > job.costUsdEstimate * HARNESS_QC_RETRY_MULTIPLIER + 1e-9;
}

/** Sets the flag once and logs the crossing; the flag never clears (spend does not go down). */
function markCostOverTarget(r: JobRecord) {
  if (r.costOverTarget || !costOverTarget(r)) return;
  r.costOverTarget = true;
  const target = roundUsd(r.costUsdEstimate * HARNESS_QC_RETRY_MULTIPLIER);
  log("warn", "harness cost over target", {
    id: r.id,
    actual: r.costUsdActual,
    estimate: r.costUsdEstimate,
    target,
  });
  // 软线，任务照跑；但它是「这一单在往贵里走」的第一个信号，比撞到硬上限早一步。
  // 标志只置一次，所以这里天然只发一次，dedupe 键仍按 jobId 兜住重放。
  void notifyAlert(
    "cost_over_target",
    {
      jobId: r.id,
      actualUsd: r.costUsdActual ?? 0,
      estimateUsd: r.costUsdEstimate,
      targetUsd: target,
    },
    `cost_over_target:${r.id}`,
  );
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

/** Token charges are far below a cent each; the LLM ledger keeps micro-dollars. */
function roundMicroUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
