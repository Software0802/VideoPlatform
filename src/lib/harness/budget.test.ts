import { describe, expect, it, vi } from "vitest";
import type { ProviderHandle, VideoProvider } from "@/lib/providers/types";
import {
  budgetCap,
  costIsIncomplete,
  costOverTarget,
  seedInFlightReservations,
  shotListPrice,
  verifyFilmDuration,
} from "./orchestrator";
import { executeShotWithRetries, ShotFailure } from "./shot-executor";
import { createShotRecords, prepareShotRetry, transitionShot, type HarnessShotRecord } from "./shot-state";
import type { IdentityBible, Shot } from "./types";
import { parseVisualQcResponse, visualQcPasses } from "./visual-qc";

/**
 * Review 2026-09-05 R04–R08: the ledger must add up across retries, the budget gate
 * must run before every paid attempt, identity cannot be averaged away, and the
 * stitched film gets its own duration check.
 */

const bible: IdentityBible = {
  version: 1,
  logline: "fixture",
  style: { palette: ["amber"], lighting: "soft", lens: "35mm", era: "now", doNotChange: [] },
  characters: [],
  locations: [],
  props: [],
};

const shot: Shot = {
  id: "shot_0",
  index: 0,
  durationSec: 5,
  prompt: "fixture shot",
  characterIds: [],
  route: "t2v",
  continuity: "hard_cut",
  generateAudio: false,
};

/** grok-imagine-video-1.5 按 $0.08/s：5s → $0.40、10s → $0.80。 */
const pricing = { model: "grok-imagine-video-1.5" };

function provider(submit: VideoProvider["submit"], poll: VideoProvider["poll"]): VideoProvider {
  return {
    id: "grok",
    capabilities: () => ({ modes: ["text_to_video"], maxDurationSec: 15, supportsLastFrameLock: false, maxResolution: "1080p" }),
    submit,
    poll,
  };
}

describe("R05 shot cost ledger", () => {
  it("adds each attempt's charge instead of overwriting the previous one", () => {
    let record = createShotRecords([shot])[0]!;
    record = transitionShot(record, "submitting");
    record = transitionShot(record, "persisting", { costUsd: 1.2 });
    record = transitionShot(record, "failed", { error: { code: "qc_visual", message: "drift" } });
    record = prepareShotRetry(record);
    expect(record).toMatchObject({ status: "queued", retries: 1, costUsd: 1.2, priorCostUsd: 1.2 });
  });

  it("books two $1.20 attempts as $2.40 on the shot through the executor", async () => {
    let attempt = 0;
    const submit = vi.fn(async (): Promise<ProviderHandle> => ({ providerId: "grok", remoteId: `remote-${attempt++}` }));
    const poll = vi.fn(async () => ({
      status: "done" as const,
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
      usage: { costUsdActual: 1.2 },
    }));
    let persistCalls = 0;
    const result = await executeShotWithRetries({
      jobId: "job_ledger",
      shot,
      bible,
      record: createShotRecords([shot])[0]!,
      provider: provider(submit, poll),
      model: "grok-imagine-video-1.5",
      resolveAsset: () => ({ kind: "data_uri", dataUri: "data:image/jpeg;base64,x" }),
      persistOutput: async () => {
        persistCalls += 1;
        if (persistCalls === 1) throw new ShotFailure("qc_duration", "short");
        return "shots/0/video.mp4";
      },
      pollIntervalMs: 0,
    });
    expect(result).toMatchObject({ status: "succeeded", retries: 1, costUsd: 2.4 });
    expect(result.costUnknown).toBeUndefined();
  });

  it("flags a paid attempt without usage as unknown instead of booking zero", async () => {
    const submit = vi.fn(async (): Promise<ProviderHandle> => ({ providerId: "grok", remoteId: "remote-0" }));
    const poll = vi.fn(async () => ({ status: "done" as const, progress: 100, remoteUrl: "http://fixture/video.mp4" }));
    const result = await executeShotWithRetries({
      jobId: "job_unknown",
      shot,
      bible,
      record: createShotRecords([shot])[0]!,
      provider: provider(submit, poll),
      model: "grok-imagine-video-1.5",
      resolveAsset: () => ({ kind: "data_uri", dataUri: "data:image/jpeg;base64,x" }),
      persistOutput: async () => "shots/0/video.mp4",
      pollIntervalMs: 0,
    });
    expect(result).toMatchObject({ status: "succeeded", costUsd: 0, costUnknown: true });
    expect(costIsIncomplete({ harnessShots: [result] }, "grok")).toBe(true);
    expect(costIsIncomplete({ harnessShots: [result] }, "mock")).toBe(false);
    // A priced LLM call is booked in USD, so it no longer makes the ledger a lower bound;
    // only a call that came back without usage does (R-P1-2).
    expect(
      costIsIncomplete(
        { harnessShots: [], llmUsage: { calls: 1, promptTokens: 10, completionTokens: 5, unpricedCalls: 0, costUsd: 0.0001 } },
        "grok",
      ),
    ).toBe(false);
    expect(
      costIsIncomplete(
        { harnessShots: [], llmUsage: { calls: 1, promptTokens: 0, completionTokens: 0, unpricedCalls: 1, costUsd: 0 } },
        "grok",
      ),
    ).toBe(true);
  });

  it("flags spend above 1.5 × the submit-time estimate without touching the ×2 hard cap", () => {
    expect(costOverTarget({ costUsdEstimate: 2.1, costUsdActual: 3.15 })).toBe(false);
    expect(costOverTarget({ costUsdEstimate: 2.1, costUsdActual: 3.16 })).toBe(true);
    expect(costOverTarget({ costUsdEstimate: 2.1, costUsdActual: null })).toBe(false);
    expect(budgetCap({ costUsdEstimate: 2.1 }, 2)).toBe(4.2);
  });

  it("caps the budget on the submit-time estimate, not the Director's own plan", () => {
    // evals/rubric.md §5 measures spend against the estimate the user saw at submit time;
    // a pricier plan must not raise its own ceiling (R-P1-1).
    expect(budgetCap({ costUsdEstimate: 2.1, costUsdPlanned: null }, 2)).toBe(4.2);
    expect(budgetCap({ costUsdEstimate: 2.1, costUsdPlanned: 2.4 }, 2)).toBe(4.2);
    expect(shotListPrice({ route: "t2v", durationSec: 10 }, pricing)).toBe(0.8);
    // 计价跟着 provider/模型走，不再是 grok 费率一家之言。
    expect(shotListPrice({ route: "i2v", durationSec: 10 }, { model: "kling-2.6", video: { resolution: "720p", audio: "off", provider: "kling" } })).toBeGreaterThan(0);
  });
});

describe("in-flight reservations survive a restart", () => {
  it("re-reserves only shots that are upstream and not yet charged", () => {
    const shots: Shot[] = [0, 1, 2, 3, 4].map((i) => ({ ...shot, id: `shot_${i}`, index: i }));
    const reserved = new Map<string, number>();
    seedInFlightReservations(
      [
        { id: "shot_0", status: "pending", remoteId: "r0" }, // polling upstream: charge not booked yet
        { id: "shot_1", status: "submitting", remoteId: "r1" }, // recovered to pending: same
        { id: "shot_2", status: "persisting", remoteId: "r2" }, // charge already in costUsd
        { id: "shot_3", status: "submitting" }, // no remote id: escalated, never resumes
        { id: "shot_4", status: "queued" }, // reserves through beforeAttempt like any fresh attempt
      ],
      shots,
      reserved,
      pricing,
    );
    expect([...reserved.keys()].sort()).toEqual(["shot:shot_0", "shot:shot_1"]);
    expect(reserved.get("shot:shot_0")).toBe(shotListPrice(shot, pricing));
  });
});

describe("R06 budget gate runs before every attempt", () => {
  it("calls beforeAttempt on the retry and stops terminally without another paid submit", async () => {
    const submit = vi.fn(async (): Promise<ProviderHandle> => ({ providerId: "grok", remoteId: "remote-0" }));
    const poll = vi.fn(async () => ({
      status: "done" as const,
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
      usage: { costUsdActual: 3 },
    }));
    const attempts: number[] = [];
    const states: HarnessShotRecord[] = [];
    const result = await executeShotWithRetries({
      jobId: "job_budget",
      shot,
      bible,
      record: createShotRecords([shot])[0]!,
      provider: provider(submit, poll),
      model: "grok-imagine-video-1.5",
      resolveAsset: () => ({ kind: "data_uri", dataUri: "data:image/jpeg;base64,x" }),
      beforeAttempt: async (_shot, record) => {
        attempts.push(record.retries);
        if (record.costUsd + 1.2 > 4) {
          throw new ShotFailure("budget_exceeded", "over cap", { terminal: true });
        }
      },
      persistOutput: async () => {
        throw new ShotFailure("qc_visual", "drift");
      },
      onState: (record) => {
        states.push(record);
      },
      pollIntervalMs: 0,
    });
    expect(attempts).toEqual([0, 1]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("needs_review");
    expect(result.error).toMatchObject({ code: "budget_exceeded" });
    expect(states.map((s) => s.status)).toContain("needs_review");
  });

  it("escalates a terminal failure raised mid-attempt without scheduling a retry", async () => {
    // The visual-QC budget reserve throws from inside persistOutput. Before, that only became
    // terminal once the retry's beforeAttempt gate happened to fail as well.
    const submit = vi.fn(async (): Promise<ProviderHandle> => ({ providerId: "grok", remoteId: "remote-0" }));
    const poll = vi.fn(async () => ({
      status: "done" as const,
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
      usage: { costUsdActual: 1.2 },
    }));
    const attempts: number[] = [];
    const states: HarnessShotRecord[] = [];
    const result = await executeShotWithRetries({
      jobId: "job_budget_terminal_persist",
      shot,
      bible,
      record: createShotRecords([shot])[0]!,
      provider: provider(submit, poll),
      model: "grok-imagine-video-1.5",
      resolveAsset: () => ({ kind: "data_uri", dataUri: "data:image/jpeg;base64,x" }),
      beforeAttempt: async (_shot, record) => {
        attempts.push(record.retries);
      },
      persistOutput: async () => {
        throw new ShotFailure("budget_exceeded", "visual QC reserve over cap", { terminal: true });
      },
      onState: (record) => {
        states.push(record);
      },
      pollIntervalMs: 0,
    });
    expect(attempts).toEqual([0]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("needs_review");
    expect(result.error).toMatchObject({ code: "budget_exceeded" });
    expect(states.map((s) => s.status).slice(-2)).toEqual(["failed", "needs_review"]);
    // The attempt's charge stays on the books even though the shot is escalated.
    expect(result.costUsd).toBe(1.2);
  });
});

describe("R04 identity floor", () => {
  it("does not let perfect lighting rescue a face swap", () => {
    const swapped = parseVisualQcResponse(
      JSON.stringify({ face: 0, hair: 1, wardrobe: 1, lighting: 1, palette: 1, notes: "" }),
    );
    expect(swapped.overall).toBe(0.8);
    expect(swapped.identity).toBe(0);
    expect(visualQcPasses(swapped, 0.7)).toBe(false);
    const stable = parseVisualQcResponse(
      JSON.stringify({ face: 0.8, hair: 0.8, wardrobe: 0.9, lighting: 0.6, palette: 0.7, notes: "" }),
    );
    expect(visualQcPasses(stable, 0.7)).toBe(true);
  });
});

describe("R08 whole-film duration", () => {
  it("expects target + settle and lets tolerance grow with clip count", () => {
    expect(verifyFilmDuration(30.04, 30, 2, false)).toMatchObject({ ok: true, expectedSec: 30, settleSec: 0, toleranceSec: 0.8 });
    expect(verifyFilmDuration(30.75, 30, 2, true)).toMatchObject({ ok: true, expectedSec: 30.75, settleSec: 0.75 });
    expect(verifyFilmDuration(31.0, 30, 2, false).ok).toBe(false);
    expect(verifyFilmDuration(28, 30, 4, false).ok).toBe(false);
    expect(verifyFilmDuration(60.5, 60, 4, false).ok).toBe(true);
  });
});
