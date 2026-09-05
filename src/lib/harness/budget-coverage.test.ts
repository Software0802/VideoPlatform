import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runFfmpeg } from "@/lib/ffmpeg";
import type { JobRecord } from "@/lib/jobs/schema";
import type { ProviderGenerateRequest, ProviderHandle, VideoProvider } from "@/lib/providers/types";
import type { DirectorInput } from "./director";
import type { LlmUsage } from "./llm-usage";
import { mockDirectorPlan } from "./mock-director";

/**
 * Coverage for the cost-ledger contract that lands alongside `src/lib/cost.ts`'s
 * `LLM_RATE_USD_PER_MTOKEN` / `estimateLlmCostUsd` / `LLM_RESERVE_USD`:
 *
 *   - `budgetCap` is pinned to the submit-time estimate, never the Director's own figure.
 *   - Every paid call the orchestrator can make (Director, character sheets, visual QC,
 *     shot generation) reserves its list price against the cap *before* it happens, so a
 *     job that cannot afford a step never makes the paid call for that step.
 *   - An LLM call that came back with usage is priced and booked; one that came back
 *     with no usage at all (`onUsage(null)`) is the only thing that makes the ledger
 *     `costIncomplete` and the only thing that stops an automatic retry (`budget_unknown`).
 *
 * These are written against the interface the coder is landing in the same change, so a
 * missing export or a different call shape is expected to show up as a compile or runtime
 * failure here rather than a silently-wrong assertion.
 */

let dataRoot = "";
let writeJob: (record: JobRecord) => Promise<JobRecord>;
let readJob: (id: string) => Promise<JobRecord | null>;
let createHarnessOrchestrator: typeof import("./orchestrator").createHarnessOrchestrator;
let HarnessFailure: typeof import("./orchestrator").HarnessFailure;
let budgetCap: typeof import("./orchestrator").budgetCap;
let estimateHarnessCostUsd: typeof import("@/lib/cost").estimateHarnessCostUsd;
let estimateLlmCostUsd: typeof import("@/lib/cost").estimateLlmCostUsd;
let LLM_RESERVE_USD: typeof import("@/lib/cost").LLM_RESERVE_USD;
let DIRECTOR_MODEL: typeof import("./director").DIRECTOR_MODEL;

type DirectorHooks = { onUsage: (usage: LlmUsage | null) => Promise<void> };

function record(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    schemaVersion: 1,
    id,
    status: "queued",
    progress: 0,
    mode: "text_to_video",
    model: "grok-imagine-video-1.5",
    provider: "mock",
    prompt: "预算门禁 fixture：雨夜外滩长镜",
    durationSec: 30,
    aspectRatio: "16:9",
    resolution: "720p",
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: true },
    costUsdEstimate: 2.4,
    costUsdActual: null,
    imageResolution: null,
    error: null,
    output: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    bible: null,
    shots: null,
    assets: {},
    ...over,
  };
}

/** A provider whose submit must never be reached; it fails loudly instead of silently succeeding. */
function noopProvider(): VideoProvider & { submit: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async (): Promise<ProviderHandle> => {
    throw new Error("submit 不应该在预算门禁之前被调用");
  });
  return {
    id: "mock",
    capabilities: () => ({
      modes: ["text_to_video", "image_to_video", "text_to_image"],
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    }),
    submit,
    poll: vi.fn(async () => ({ status: "done" as const, progress: 100 })),
  };
}

/** A non-mock provider that renders a real lavfi clip (so technical QC has something to probe) and reports a fixed cost. */
function paidClipProvider(opts: {
  durationFor: (req: ProviderGenerateRequest) => number;
  costFor?: (req: ProviderGenerateRequest) => number;
}): VideoProvider & { submit: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async (req: ProviderGenerateRequest): Promise<ProviderHandle> => {
    if (req.mode === "image_to_video" && req.startImage?.kind === "path") {
      await access(req.startImage.path);
    }
    const { mediaStore } = await import("@/lib/storage/local-fs");
    const abs = path.join(mediaStore.jobDir(req.jobId), "tmp/video.mp4");
    await mkdir(path.dirname(abs), { recursive: true });
    const durationSec = Math.max(1, opts.durationFor(req));
    await runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=64x36:r=12:d=${durationSec}`,
      "-t",
      String(durationSec),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      abs,
    ]);
    return {
      providerId: "grok",
      localVideoPath: "tmp/video.mp4",
      costUsdActual: opts.costFor ? opts.costFor(req) : 1.2,
    };
  });
  return {
    id: "grok",
    capabilities: () => ({
      modes: ["text_to_video", "image_to_video", "text_to_image"],
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    }),
    submit,
    poll: vi.fn(async () => ({ status: "done" as const, progress: 100 })),
  };
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-budget-coverage-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ writeJob, readJob } = await import("@/lib/jobs/store"));
  ({ createHarnessOrchestrator, HarnessFailure, budgetCap } = await import("./orchestrator"));
  ({ estimateHarnessCostUsd, estimateLlmCostUsd, LLM_RESERVE_USD } = await import("@/lib/cost"));
  ({ DIRECTOR_MODEL } = await import("./director"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("budgetCap pins to the submit-time estimate", () => {
  it("ignores costUsdPlanned even when the Director already ran", () => {
    expect(budgetCap({ costUsdEstimate: 2.1, costUsdPlanned: null }, 2)).toBe(4.2);
    // Same estimate, a very different (and much larger) planned figure: the cap must not move.
    expect(budgetCap({ costUsdEstimate: 2.1, costUsdPlanned: 99 }, 2)).toBe(4.2);
  });
});

describe("the budget gate runs before the Director is ever called", () => {
  /**
   * `deps.director` is a full override of "how do we get a plan" — like the built-in
   * `job.provider === "mock"` branch, it is presumed free and is *not* wrapped by the
   * Director reservation (only the real upstream `createDirectorPlan` fallback is). So
   * this only exercises the real branch: no `director` override, a non-mock provider,
   * and a cap so tight the reservation must throw before `createDirectorPlan` (hence
   * before any network call / API key) is ever reached.
   */
  it("blocks the real Director call on its own reserve, before any plan exists and before any submit", async () => {
    const id = "job_budget_director_reserve";
    // Cap is exactly 0: even the smallest positive reserve for one LLM call cannot fit.
    await writeJob(record(id, { provider: "grok", costUsdEstimate: 0 }));
    const provider = noopProvider();

    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      // No `director` override on purpose: falls through to the real createDirectorPlan
      // branch, which the reservation must prevent from ever running.
      pollIntervalMs: 0,
    });

    await expect(orchestrator.execute(id)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(provider.submit).not.toHaveBeenCalled();
    const job = await readJob(id);
    // No plan was ever produced: the gate fired strictly before directing did any work,
    // and no network call to the (absent, in this test env) upstream was attempted.
    expect(job?.harnessPlan ?? null).toBeNull();
  });

  it("lets an injected (free) director bypass its own reserve, unlike the real upstream call", async () => {
    // Documents the asymmetry above from the other side: a test/mock director is treated
    // like the free mock path, not like a paid call, so the same cap=0 job succeeds in
    // reaching the plan when a director is injected.
    const id = "job_budget_director_reserve_bypassed";
    await writeJob(record(id, { provider: "grok", costUsdEstimate: 0 }));
    const fakeDirector = vi.fn(async (input: DirectorInput) => mockDirectorPlan(input));
    const provider = noopProvider();

    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      director: fakeDirector,
      budgetMultiplier: 1,
      pollIntervalMs: 0,
    });

    // The plan itself ($2.40) still cannot fit a $0 cap, so this still ends in
    // budget_exceeded — just from guardPlannedBudget after the (uncharged) fake ran,
    // not from a Director reserve check.
    await expect(orchestrator.execute(id)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(fakeDirector).toHaveBeenCalledTimes(1);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("stops right after Directing when the whole plan cannot fit, before the first shot submit", async () => {
    const id = "job_budget_plan_cost";
    const plan = mockDirectorPlan({ prompt: "预算门禁：全片成本", targetDurationSec: 30 });
    const planCost = estimateHarnessCostUsd(plan.packing.clips);
    // Sanity on the fixture: a single LLM text call must be far cheaper than a 30s film,
    // otherwise the estimate picked below would not isolate the check this test targets.
    expect(LLM_RESERVE_USD.director).toBeLessThan(planCost);
    const estimate = Math.round(((LLM_RESERVE_USD.director + planCost) / 2) * 100) / 100;
    expect(estimate).toBeGreaterThanOrEqual(LLM_RESERVE_USD.director);
    expect(estimate).toBeLessThan(planCost);

    await writeJob(record(id, { costUsdEstimate: estimate }));
    const fakeDirector = vi.fn(async (input: DirectorInput) => mockDirectorPlan(input));
    const provider = noopProvider();

    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      director: fakeDirector,
      budgetMultiplier: 1,
      pollIntervalMs: 0,
    });

    await expect(orchestrator.execute(id)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(fakeDirector).toHaveBeenCalledTimes(1);
    expect(provider.submit).not.toHaveBeenCalled();
  });
});

describe("LLM usage feeds the same ledger as shot spend", () => {
  it("prices a reported Director usage into the ledger and lets a QC retry still submit", async () => {
    const id = "job_budget_llm_priced";
    await writeJob(record(id, { provider: "grok", costUsdEstimate: 2.4 }));
    let submitCalls = 0;
    const provider = paidClipProvider({
      // The very first submit (shot 0's first attempt) comes back 5s short and fails
      // duration QC; shot 0's own tail-chained dependency means every later submit
      // (its retry, then shot 1) is deterministically ordered after it.
      durationFor: (req) => {
        submitCalls += 1;
        const base = req.durationSec ?? 8;
        return submitCalls === 1 ? base - 5 : base;
      },
    });
    const usage: LlmUsage = { promptTokens: 1000, completionTokens: 500 };
    const fakeDirector = vi.fn(
      async (input: DirectorInput, _job: JobRecord, hooks: DirectorHooks) => {
        await hooks.onUsage(usage);
        return mockDirectorPlan(input);
      },
    );

    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      director: fakeDirector,
      visualThreshold: () => null,
      pollIntervalMs: 0,
      stitchSize: () => ({ width: 64, height: 36 }),
    });

    await orchestrator.execute(id);
    const job = await readJob(id);
    expect(job?.status).toBe("persisting");
    expect(job?.llmUsage?.calls).toBe(1);
    expect(job?.llmUsage?.unpricedCalls ?? 0).toBe(0);
    const expectedLlmCost = estimateLlmCostUsd(DIRECTOR_MODEL, usage);
    expect(job?.llmUsage?.costUsd).toBeCloseTo(expectedLlmCost, 2);
    expect(job?.costIncomplete).toBe(false);
    // Shot ledger: shot 0 books two $1.20 attempts (fail then succeed), shot 1 books one.
    expect(job?.costUsdActual).toBeCloseTo(3.6 + expectedLlmCost, 2);
    // 2 shots + 1 retry: the retry was not blocked by budget_unknown.
    expect(provider.submit).toHaveBeenCalledTimes(3);
  }, 120_000);

  it("marks an unpriced Director call incomplete and lets it terminate the very next retry", async () => {
    const id = "job_budget_llm_unpriced";
    await writeJob(record(id, { provider: "grok", costUsdEstimate: 2.4 }));
    // Always 5s short: shot 0's first attempt fails QC and schedules a retry.
    const provider = paidClipProvider({ durationFor: (req) => (req.durationSec ?? 8) - 5 });
    const fakeDirector = vi.fn(
      async (input: DirectorInput, _job: JobRecord, hooks: DirectorHooks) => {
        await hooks.onUsage(null);
        return mockDirectorPlan(input);
      },
    );

    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      director: fakeDirector,
      visualThreshold: () => null,
      pollIntervalMs: 0,
    });

    await expect(orchestrator.execute(id)).rejects.toBeInstanceOf(HarnessFailure);
    const job = await readJob(id);
    expect(job?.llmUsage?.unpricedCalls).toBe(1);
    expect(job?.costIncomplete).toBe(true);
    // The retry never reaches submit: only shot 0's first (failed) attempt was billed.
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(job?.harnessShots?.[0]).toMatchObject({
      status: "needs_review",
      error: { code: "budget_unknown" },
    });
  }, 60_000);
});

describe("budget reserve before a visual-QC call", () => {
  /**
   * Construction: costUsdEstimate is set to exactly the mock plan's own packing cost
   * (30s -> two $1.20 shots = $2.40), so the whole-plan check above passes with no
   * slack, and costUsdActual is pre-loaded to $1.20 to stand in for a character-sheet
   * cost already booked before shot generation (the same bookkeeping the orchestrator
   * already does for keyframe sheets). That leaves exactly enough headroom for shot 0's
   * OWN generation ($1.20) and not one cent more: once shot 0 succeeds, spend sits
   * exactly at the cap, so *any* positive visual-QC reserve must push it over before the
   * scorer is ever asked to run. Shot 1 depends on shot 0 (tail-chain) and is blocked
   * once shot 0 needs review, so it never has a chance to spend either.
   */
  it("reserves the visual-QC list price before scoring and never calls the scorer when it cannot fit", async () => {
    const id = "job_budget_visual_qc_reserve";
    await writeJob(
      record(id, { provider: "grok", costUsdEstimate: 2.4, costUsdActual: 1.2 }),
    );
    const provider = paidClipProvider({ durationFor: (req) => req.durationSec ?? 8 });
    const fakeVisualScorer = vi.fn(async () => ({
      face: 1,
      hair: 1,
      wardrobe: 1,
      lighting: 1,
      palette: 1,
      notes: "",
      overall: 1,
      identity: 1,
    }));

    const orchestrator = createHarnessOrchestrator({
      enabled: () => true,
      provider,
      director: vi.fn(async (input: DirectorInput) => mockDirectorPlan(input)),
      visualThreshold: () => 0.7,
      visualScorer: fakeVisualScorer,
      budgetMultiplier: 1,
      pollIntervalMs: 0,
    });

    await expect(orchestrator.execute(id)).rejects.toBeInstanceOf(HarnessFailure);
    const job = await readJob(id);
    expect(fakeVisualScorer).not.toHaveBeenCalled();
    // Only shot 0's own (technically successful) attempt was ever submitted.
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(job?.harnessShots?.[0]).toMatchObject({
      status: "needs_review",
      error: { code: "budget_exceeded" },
    });
  }, 60_000);

  // The character-sheet half of this same reserve (grok_r2v shots, identity sheets before
  // R2V generation) needs a full identity-sheet fixture (fake requestIdentitySheet /
  // persistIdentitySheet plumbing plus a bible with a character) to exercise meaningfully.
  // Per the task's own allowance, this is left to a follow-up rather than bolted on here
  // as a shallow/unconvincing check.
  it.skip("reserves RATE_USD_PER_IMAGE before each character sheet (needs identity-sheet fixtures)", () => {});
});
