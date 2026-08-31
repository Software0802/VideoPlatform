import { describe, expect, it } from "vitest";
import { createShotRecords, type HarnessShotRecord } from "./shot-state";
import { executeShotPlan } from "./shot-coordinator";
import type { Shot } from "./types";

const shots: Shot[] = [
  {
    id: "shot_0",
    index: 0,
    durationSec: 8,
    prompt: "独立镜头 A",
    characterIds: [],
    route: "grok_t2v",
    continuity: "hard_cut",
    generateAudio: false,
  },
  {
    id: "shot_1",
    index: 1,
    durationSec: 8,
    prompt: "独立镜头 B",
    characterIds: [],
    route: "grok_t2v",
    continuity: "hard_cut",
    generateAudio: false,
  },
  {
    id: "shot_2",
    index: 2,
    durationSec: 8,
    prompt: "接续镜头",
    characterIds: [],
    route: "grok_i2v",
    continuity: "tail_chain",
    startFrame: { source: "extracted", assetId: "shots/1/link.jpg" },
    generateAudio: false,
  },
  {
    id: "shot_3",
    index: 3,
    durationSec: 8,
    prompt: "延长镜头",
    characterIds: [],
    route: "grok_extend",
    continuity: "extend",
    generateAudio: false,
  },
];

function queuedRecords() {
  return createShotRecords(shots);
}

describe("shot coordinator", () => {
  it("runs independent shots in parallel and waits for dependent shots", async () => {
    const records = queuedRecords();
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await executeShotPlan({
      shots,
      records,
      maxParallel: 2,
      execute: async (shot, record) => {
        starts.push(shot.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, shot.id === "shot_0" ? 15 : 2));
        active -= 1;
        return { ...record, status: "succeeded" as const, outputPath: `shots/${shot.index}/video.mp4` };
      },
    });

    expect(maxActive).toBe(2);
    expect(starts.slice(0, 2)).toEqual(expect.arrayContaining(["shot_0", "shot_1"]));
    expect(starts.indexOf("shot_2")).toBeGreaterThan(starts.indexOf("shot_1"));
    expect(starts.indexOf("shot_3")).toBeGreaterThan(starts.indexOf("shot_2"));
    expect(result.every((record) => record.status === "succeeded")).toBe(true);
  });

  it("resumes in-flight pending shots instead of skipping them", async () => {
    const records = queuedRecords();
    records[0] = { ...records[0]!, status: "pending", remoteId: "remote-0" };
    const executed: string[] = [];
    const result = await executeShotPlan({
      shots,
      records,
      maxParallel: 2,
      execute: async (shot, record) => {
        executed.push(shot.id);
        return { ...record, status: "succeeded" as const, outputPath: `shots/${shot.index}/video.mp4` };
      },
    });
    expect(executed).toContain("shot_0");
    expect(result[0]).toMatchObject({ status: "succeeded", outputPath: "shots/0/video.mp4" });
  });

  it("does not execute an already succeeded shot", async () => {
    const records = queuedRecords();
    records[0] = { ...records[0]!, status: "succeeded", outputPath: "shots/0/video.mp4" };
    const executed: string[] = [];
    const result = await executeShotPlan({
      shots,
      records,
      maxParallel: 2,
      execute: async (shot, record) => {
        executed.push(shot.id);
        return { ...record, status: "succeeded" as const, outputPath: `shots/${shot.index}/video.mp4` };
      },
    });
    expect(executed).not.toContain("shot_0");
    expect(result[0]).toMatchObject({ status: "succeeded", outputPath: "shots/0/video.mp4" });
  });

  it("blocks a dependent shot when its prerequisite needs review", async () => {
    const records = queuedRecords();
    records[1] = {
      ...records[1]!,
      status: "needs_review",
      error: { code: "retry_exhausted", message: "fixture" },
    };
    const executed: string[] = [];
    const states: HarnessShotRecord[] = [];
    const result = await executeShotPlan({
      shots,
      records,
      maxParallel: 2,
      execute: async (shot, record) => {
        executed.push(shot.id);
        return { ...record, status: "succeeded" as const, outputPath: `shots/${shot.index}/video.mp4` };
      },
      onState: async (record) => {
        states.push(record);
      },
    });
    expect(executed).not.toContain("shot_2");
    expect(result[2]).toMatchObject({ status: "needs_review", error: { code: "dependency_failed" } });
    expect(states.some((record) => record.id === "shot_2" && record.status === "needs_review")).toBe(true);
  });

  it("marks dependency cycles for review and validates the concurrency limit", async () => {
    const records = queuedRecords();
    await expect(
      executeShotPlan({ shots, records, maxParallel: 0, execute: async (_shot, record) => record }),
    ).rejects.toThrow("并发上限无效");
    const result = await executeShotPlan({
      shots: shots.slice(0, 2),
      records: records.slice(0, 2),
      maxParallel: 1,
      dependencies: (shot) => (shot.id === "shot_0" ? ["shot_1"] : ["shot_0"]),
      execute: async (_shot, record) => record,
    });
    expect(result.map((record) => record.status)).toEqual(["needs_review", "needs_review"]);
  });
});
