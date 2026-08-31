import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createShotRecords,
  harnessShotRecordSchema,
  prepareShotRetry,
  runnableShots,
  transitionShot,
} from "./shot-state";
import type { Shot } from "./types";

const shots: Shot[] = [
  {
    id: "shot_0",
    index: 0,
    durationSec: 15,
    prompt: "第一镜",
    characterIds: [],
    route: "grok_t2v",
    continuity: "hard_cut",
    generateAudio: false,
  },
  {
    id: "shot_1",
    index: 1,
    durationSec: 10,
    prompt: "第二镜",
    characterIds: [],
    route: "grok_extend",
    continuity: "extend",
    generateAudio: false,
  },
];

describe("harness shot state", () => {
  it("rejects an empty shot plan", () => {
    expect(() => createShotRecords([])).toThrow("shot 计划不能为空");
  });

  it("initializes every planned shot as queued with zero cost", () => {
    expect(createShotRecords(shots)).toEqual([
      expect.objectContaining({ id: "shot_0", index: 0, status: "queued", retries: 0, costUsd: 0 }),
      expect.objectContaining({ id: "shot_1", index: 1, status: "queued", retries: 0, costUsd: 0 }),
    ]);
  });

  it("allows the execution path but rejects rerunning a succeeded shot", () => {
    const initial = createShotRecords(shots)[0]!;
    const submitting = transitionShot(initial, "submitting");
    const pending = transitionShot(submitting, "pending");
    const persisting = transitionShot(pending, "persisting");
    const succeeded = transitionShot(persisting, "succeeded", {
      outputPath: "shots/0/video.mp4",
      costUsd: 1.2,
    });
    expect(succeeded.outputPath).toBe("shots/0/video.mp4");
    expect(() => transitionShot(succeeded, "submitting")).toThrow("illegal shot transition");
    expect(runnableShots([succeeded, ...createShotRecords(shots).slice(1)])).toHaveLength(1);
  });

  it("queues failed shots twice, then moves the third failure to needs_review", () => {
    const failed = {
      ...createShotRecords(shots)[0]!,
      status: "failed" as const,
      remoteId: "remote-old",
      outputPath: "shots/0/old.mp4",
      retries: 0,
      costUsd: 0.8,
      error: { code: "failed", message: "fixture" },
    };
    const retry1 = prepareShotRetry(failed);
    expect(retry1).toMatchObject({ status: "queued", retries: 1, costUsd: 0.8 });
    expect(retry1.remoteId).toBeUndefined();
    expect(retry1.outputPath).toBeUndefined();
    const retry2 = prepareShotRetry({ ...retry1, status: "failed" });
    expect(retry2).toMatchObject({ status: "queued", retries: 2 });
    const review = prepareShotRetry({ ...retry2, status: "failed" });
    expect(review).toMatchObject({ status: "needs_review", retries: 2 });
  });

  it("strictly validates persisted shot records", () => {
    expect(() =>
      harnessShotRecordSchema.parse({
        ...createShotRecords(shots)[0],
        typo: true,
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      harnessShotRecordSchema.parse({
        ...createShotRecords(shots)[0],
        costUsd: -1,
      }),
    ).toThrow(z.ZodError);
  });
});
