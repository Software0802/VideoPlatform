import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "@/lib/jobs/schema";
import type { ProviderHandle, VideoProvider } from "@/lib/providers/types";
import { executeShotWithRetries } from "./shot-executor";
import { recoverHarnessShot, recoverShotDecision } from "./shot-recover";
import { mockDirectorPlan } from "./mock-director";
import type { HarnessShotRecord } from "./shot-state";
import type { IdentityBible, Shot } from "./types";

/**
 * A shot that crashed mid-`submitting` with no `remoteId` is genuinely uncertain: the
 * upstream call may have gone out and be running (or even billing) with nothing local to
 * resume it from. Requeuing it (the old behaviour) would silently double-submit if the
 * first call *did* land. This file covers the new "review" outcome for that case, plus
 * the ledger fields (`priorCostUsd` / `costUnknown`) recovery must not drop along the way,
 * end to end through the shot executor and through `runPersistedPlan`.
 */

function record(over: Partial<HarnessShotRecord> = {}): HarnessShotRecord {
  return {
    id: "shot_0",
    index: 0,
    status: "queued",
    retries: 1,
    costUsd: 0.4,
    ...over,
  };
}

describe("recoverShotDecision: an unconfirmed submit is uncertain, not a safe requeue", () => {
  it("treats submitting-with-no-remote-id as needing review, unlike persisting-with-no-remote-id", () => {
    expect(recoverShotDecision("submitting", false)).toBe("review");
    expect(recoverShotDecision("persisting", false)).toBe("requeue");
    expect(recoverShotDecision("submitting", true)).toBe("resume-pending");
  });
});

describe("recoverHarnessShot: review keeps the ledger, it does not reset it", () => {
  it("sends a crashed submit to needs_review with uncertain_submit and keeps costUsd/priorCostUsd/costUnknown/retries", () => {
    const crashed = record({
      status: "submitting",
      retries: 1,
      costUsd: 0.8,
      priorCostUsd: 0.4,
      costUnknown: true,
    });
    const recovered = recoverHarnessShot(crashed);
    expect(recovered).toMatchObject({
      status: "needs_review",
      retries: 1,
      costUsd: 0.8,
      priorCostUsd: 0.4,
      costUnknown: true,
      error: { code: "uncertain_submit" },
    });
  });

  it("still requeues a crashed persist, folding the abandoned attempt's own charge into priorCostUsd", () => {
    // "persisting" with no remoteId is only reached via a synchronous provider result
    // (attemptCost already added this attempt's charge on top of the old priorCostUsd),
    // so costUsd here is the *cumulative* total including the attempt being abandoned.
    // The next attempt must build on that full total, not the stale pre-attempt figure,
    // or the abandoned attempt's own spend would quietly fall off the ledger.
    const crashed = record({
      status: "persisting",
      retries: 1,
      costUsd: 0.5,
      priorCostUsd: 0.3,
      costUnknown: true,
    });
    const recovered = recoverHarnessShot(crashed);
    expect(recovered).toMatchObject({
      status: "queued",
      retries: 1,
      costUsd: 0.5,
      priorCostUsd: 0.5,
      costUnknown: true,
    });
    expect(recovered.remoteId).toBeUndefined();
  });
});

describe("end-to-end ledger: a recovered requeue still adds onto priorCostUsd", () => {
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
  function providerFor(submit: VideoProvider["submit"], poll: VideoProvider["poll"]): VideoProvider {
    return {
      id: "grok",
      capabilities: () => ({
        modes: ["text_to_video"],
        maxDurationSec: 15,
        supportsLastFrameLock: false,
        maxResolution: "1080p",
      }),
      submit,
      poll,
    };
  }

  it("carries a $1.20 prior attempt through recovery, then books a second $1.20 attempt as $2.40", async () => {
    // Simulates a crash right after the first attempt's cost was booked but before the
    // provider confirmed a remote id: status "persisting" with no remoteId, costUsd
    // already at $1.20 from that attempt.
    const crashed = record({
      status: "persisting",
      retries: 1,
      costUsd: 1.2,
      priorCostUsd: 1.2,
    });
    const recovered = recoverHarnessShot(crashed);
    expect(recovered).toMatchObject({ status: "queued", retries: 1, costUsd: 1.2, priorCostUsd: 1.2 });

    const submit = vi.fn(
      async (): Promise<ProviderHandle> => ({
        providerId: "grok",
        localVideoPath: "tmp/video.mp4",
        costUsdActual: 1.2,
      }),
    );
    const poll = vi.fn();

    const result = await executeShotWithRetries({
      jobId: "job_uncertain_ledger",
      shot,
      bible,
      record: recovered,
      provider: providerFor(submit, poll),
      model: "mock-video",
      resolveAsset: () => ({ kind: "data_uri", dataUri: "data:image/jpeg;base64,x" }),
      persistOutput: async () => "shots/0/video.mp4",
      pollIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: "succeeded", retries: 1, costUsd: 2.4 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });
});

describe("runPersistedPlan treats a recovered needs_review shot as terminal", () => {
  let dataRoot = "";
  let writeJob: (record: JobRecord) => Promise<JobRecord>;
  let saveHarnessPlan: typeof import("./state").saveHarnessPlan;
  let updateHarnessShot: typeof import("./state").updateHarnessShot;
  let runPersistedPlan: typeof import("./run-persisted-plan").runPersistedPlan;

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-shot-recover-uncertain-test-"));
    process.env.DATA_DIR = dataRoot;
    process.env.LUMEN_FORCE_MOCK = "1";
    ({ writeJob } = await import("@/lib/jobs/store"));
    ({ saveHarnessPlan, updateHarnessShot } = await import("./state"));
    ({ runPersistedPlan } = await import("./run-persisted-plan"));
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
    delete process.env.LUMEN_FORCE_MOCK;
    await rm(dataRoot, { recursive: true, force: true });
  });

  function baseRecord(id: string): JobRecord {
    return {
      schemaVersion: 1,
      id,
      status: "queued",
      progress: 0,
      mode: "text_to_video",
      model: "grok-imagine-video-1.5",
      provider: "mock",
      prompt: "fixture",
      durationSec: 30,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      priceCny: 0,
      costUsdEstimate: 2.4,
      costUsdActual: null,
      imageResolution: null,
      error: null,
      output: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      bible: null,
      shots: null,
      assets: {},
    };
  }

  it("never re-submits a shot recovery already sent to needs_review, and blocks its dependent shot too", async () => {
    const id = "job_uncertain_persisted_plan";
    // Two tail-chained shots (shot 1 depends on shot 0), same shape mock-director produces
    // for a 30s job, so shot 1 is guaranteed blocked once shot 0 needs review.
    const plan = mockDirectorPlan({ prompt: "fixture", targetDurationSec: 30 });
    await writeJob(baseRecord(id));
    await saveHarnessPlan(id, plan);
    // Simulate a crash right after submit went out, before any remoteId came back.
    await updateHarnessShot(id, "shot_0", "submitting");

    const submit = vi.fn(
      async (): Promise<ProviderHandle> => ({ providerId: "mock", localVideoPath: "tmp/video.mp4" }),
    );
    const poll = vi.fn();
    const persistOutput = vi.fn(async (shot: Shot) => `shots/${shot.index}/video.mp4`);

    const final = await runPersistedPlan(id, {
      maxParallel: 2,
      model: "mock-video",
      provider: {
        id: "mock",
        capabilities: () => ({
          modes: ["text_to_video", "image_to_video"],
          maxDurationSec: 15,
          supportsLastFrameLock: false,
          maxResolution: "1080p",
        }),
        submit,
        poll,
      },
      resolveAsset: (assetId: string) => ({ kind: "data_uri" as const, dataUri: assetId }),
      persistOutput,
      pollIntervalMs: 0,
    });

    expect(submit).not.toHaveBeenCalled();
    expect(persistOutput).not.toHaveBeenCalled();
    expect(final.harnessShots?.map((shot) => shot.status)).toEqual(["needs_review", "needs_review", "needs_review"]);
    expect(final.harnessShots?.[0]).toMatchObject({ error: { code: "uncertain_submit" } });
    expect(final.harnessShots?.[1]).toMatchObject({ error: { code: "dependency_failed" } });
  });
});
