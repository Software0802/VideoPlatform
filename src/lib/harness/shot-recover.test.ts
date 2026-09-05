import { describe, expect, it } from "vitest";
import { recoverHarnessShot, recoverHarnessShots, recoverShotDecision } from "./shot-recover";
import type { HarnessShotRecord } from "./shot-state";

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

describe("shot recovery", () => {
  it("requeues in-flight shots that never received a remote id", () => {
    expect(recoverShotDecision("pending", false)).toBe("requeue");
    expect(recoverShotDecision("persisting", false)).toBe("requeue");
    expect(recoverHarnessShot(record({ status: "pending", remoteId: undefined }))).toMatchObject({
      status: "queued",
      retries: 1,
      costUsd: 0.4,
    });
    expect(recoverHarnessShot(record({ status: "pending" })).remoteId).toBeUndefined();
  });

  it("sends an uncertain submit to human review instead of paying twice", () => {
    // The crash window between provider.submit returning and the remote id landing in
    // job.json may already have cost money upstream; re-submitting would pay again.
    expect(recoverShotDecision("submitting", false)).toBe("review");
    expect(recoverHarnessShot(record({ status: "submitting", remoteId: undefined }))).toMatchObject({
      status: "needs_review",
      retries: 1,
      costUsd: 0.4,
      error: { code: "uncertain_submit" },
    });
  });

  it("keeps the ledger of earlier attempts when it requeues", () => {
    expect(
      recoverHarnessShot(
        record({ status: "pending", retries: 1, costUsd: 1.2, priorCostUsd: 1.2, costUnknown: true }),
      ),
    ).toMatchObject({ status: "queued", retries: 1, costUsd: 1.2, priorCostUsd: 1.2, costUnknown: true });
  });

  it("resumes poll/persist when a remote id already exists", () => {
    expect(recoverShotDecision("submitting", true)).toBe("resume-pending");
    expect(recoverShotDecision("pending", true)).toBe("resume-pending");
    expect(recoverShotDecision("persisting", true)).toBe("resume-persisting");
    expect(
      recoverHarnessShot(record({ status: "submitting", remoteId: "remote-1" })),
    ).toMatchObject({ status: "pending", remoteId: "remote-1" });
    expect(
      recoverHarnessShot(record({ status: "persisting", remoteId: "remote-2" })),
    ).toMatchObject({ status: "persisting", remoteId: "remote-2" });
  });

  it("keeps terminal, queued, and failed shots untouched", () => {
    expect(recoverShotDecision("succeeded", true)).toBe("keep");
    expect(recoverShotDecision("needs_review", false)).toBe("keep");
    expect(recoverShotDecision("canceled", false)).toBe("keep");
    expect(recoverShotDecision("failed", false)).toBe("keep");
    expect(recoverShotDecision("queued", false)).toBe("keep");
    const succeeded = record({ status: "succeeded", outputPath: "shots/0/video.mp4" });
    expect(recoverHarnessShot(succeeded)).toEqual(succeeded);
  });

  it("recovers a mixed plan without resetting succeeded clips", () => {
    const recovered = recoverHarnessShots([
      record({ id: "shot_0", status: "succeeded", outputPath: "shots/0/video.mp4" }),
      record({ id: "shot_1", index: 1, status: "pending" }),
      record({ id: "shot_2", index: 2, status: "pending", remoteId: "remote-2" }),
    ]);
    expect(recovered.map((shot) => shot.status)).toEqual(["succeeded", "queued", "pending"]);
    expect(recovered[0]?.outputPath).toBe("shots/0/video.mp4");
    expect(recovered[2]?.remoteId).toBe("remote-2");
  });
});
