import { describe, expect, it } from "vitest";
import { canCancel, canTransition } from "./state-machine";

describe("state-machine", () => {
  it("allows sync image path submitting -> persisting", () => {
    expect(canTransition("submitting", "persisting")).toBe(true);
  });
  it("disallows succeeded -> queued", () => {
    expect(canTransition("succeeded", "queued")).toBe(false);
  });
  it("allows cancel during persisting so outputs are not committed", () => {
    expect(canTransition("persisting", "canceled")).toBe(true);
  });
  it("only allows cancel from active states", () => {
    expect(canCancel("queued")).toBe(true);
    expect(canCancel("submitting")).toBe(true);
    expect(canCancel("pending")).toBe(true);
    expect(canCancel("persisting")).toBe(true);
    expect(canCancel("directing")).toBe(true);
    expect(canCancel("keyframing")).toBe(true);
    expect(canCancel("generating_shots")).toBe(true);
    expect(canCancel("qc")).toBe(true);
    expect(canCancel("stitching")).toBe(true);
    expect(canCancel("succeeded")).toBe(false);
    expect(canCancel("failed")).toBe(false);
    expect(canCancel("expired")).toBe(false);
    expect(canCancel("canceled")).toBe(false);
  });

  it("allows the harness phase chain without opening 30/45/60", () => {
    expect(canTransition("queued", "directing")).toBe(true);
    expect(canTransition("directing", "keyframing")).toBe(true);
    expect(canTransition("keyframing", "generating_shots")).toBe(true);
    expect(canTransition("generating_shots", "qc")).toBe(true);
    expect(canTransition("qc", "generating_shots")).toBe(true);
    expect(canTransition("qc", "stitching")).toBe(true);
    expect(canTransition("stitching", "persisting")).toBe(true);
    expect(canTransition("stitching", "succeeded")).toBe(true);
    expect(canTransition("directing", "submitting")).toBe(false);
  });
});
