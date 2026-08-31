import { describe, expect, it } from "vitest";
import { JOB_STALE_MS, recoverDecision } from "./recover";

describe("recoverDecision", () => {
  it("never expires a queued job for sitting in line", () => {
    expect(recoverDecision("queued", JOB_STALE_MS * 4, false)).toBe("requeue");
  });

  it("expires only submitting/pending/persisting after 15 min", () => {
    expect(recoverDecision("pending", JOB_STALE_MS + 1, true)).toBe("expire");
    expect(recoverDecision("submitting", JOB_STALE_MS + 1, true)).toBe("expire");
    expect(recoverDecision("persisting", JOB_STALE_MS + 1, false)).toBe("expire");
    expect(recoverDecision("pending", JOB_STALE_MS - 1, true)).toBe("keep");
    expect(recoverDecision("generating_shots", JOB_STALE_MS + 1, true)).toBe("expire");
    expect(recoverDecision("generating_shots", JOB_STALE_MS - 1, true)).toBe("keep");
  });

  it("requeues submitting without a remote id", () => {
    expect(recoverDecision("submitting", 1000, false)).toBe("requeue");
  });

  it("resumes submitting that already has a remote id", () => {
    expect(recoverDecision("submitting", 1000, true)).toBe("resume-pending");
  });
});
