import { describe, expect, it, vi } from "vitest";
import {
  ProviderHttpError,
  type ProviderHandle,
  type VideoProvider,
} from "@/lib/providers/types";
import { downgradeR2vShot } from "./shot-router";
import { createShotRecords, type HarnessShotRecord } from "./shot-state";
import { executeShotWithRetries } from "./shot-executor";
import type { IdentityBible, Shot } from "./types";

const bible: IdentityBible = {
  version: 1,
  logline: "fixture",
  style: {
    palette: ["amber"],
    lighting: "soft",
    lens: "35mm",
    era: "now",
    doNotChange: [],
  },
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

function providerFor(
  submit: VideoProvider["submit"],
  poll: VideoProvider["poll"],
  id = "mock",
): VideoProvider {
  return {
    id,
    capabilities: () => ({
      modes: ["text_to_video"],
      maxDurationSec: 10,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    }),
    submit,
    poll,
  };
}

const resolveAsset = (assetId: string) => ({
  kind: "data_uri" as const,
  dataUri: `data:image/jpeg;base64,${assetId}`,
});

describe("shot executor", () => {
  it("runs submit, poll, persist, and succeeds with the measured cost", async () => {
    const handle: ProviderHandle = { providerId: "mock", remoteId: "remote-0" };
    const submit = vi.fn(async () => handle);
    const poll = vi
      .fn<VideoProvider["poll"]>()
      .mockResolvedValueOnce({ status: "pending", progress: 40 })
      .mockResolvedValueOnce({
        status: "done",
        progress: 100,
        remoteUrl: "http://fixture/video.mp4",
        fileOutputId: "file-output-0",
        usage: { costUsdActual: 1.23 },
      });
    const states: HarnessShotRecord[] = [];

    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record: createShotRecords([shot])[0]!,
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput: async (shotInput, finalHandle) => {
        void shotInput;
        expect(finalHandle.remoteUrl).toBe("http://fixture/video.mp4");
        expect(finalHandle.fileOutputId).toBe("file-output-0");
        return "shots/0/video.mp4";
      },
      onState: async (state) => {
        states.push(state);
      },
      pollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      id: "shot_0",
      status: "succeeded",
      outputPath: "shots/0/video.mp4",
      costUsd: 1.23,
      retries: 0,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(states.map((state) => state.status)).toEqual([
      "submitting",
      "pending",
      "persisting",
      "succeeded",
    ]);
  });

  it("does not submit a shot that already succeeded", async () => {
    const submit = vi.fn();
    const poll = vi.fn();
    const record = {
      ...createShotRecords([shot])[0]!,
      status: "succeeded" as const,
      outputPath: "shots/0/video.mp4",
    };
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record,
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput: vi.fn(),
    });
    expect(result).toEqual(record);
    expect(submit).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });

  it("retries provider failures twice, then requires review", async () => {
    const submit = vi.fn(async () => {
      throw new Error("upstream fixture failed");
    });
    const poll = vi.fn();
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record: createShotRecords([shot])[0]!,
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput: vi.fn(),
      onState: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ status: "needs_review", retries: 2 });
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("cleans a submitted remote handle when cancellation wins during polling", async () => {
    const handle: ProviderHandle = { providerId: "mock", remoteId: "remote-cancel" };
    const submit = vi.fn(async () => handle);
    const poll = vi.fn(async () => ({ status: "pending" as const, progress: 20 }));
    const cleanupHandle = vi.fn(async () => undefined);
    const persistOutput = vi.fn(async () => "shots/0/video.mp4");
    let checks = 0;

    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record: createShotRecords([shot])[0]!,
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput,
      cleanupHandle,
      isCanceled: async () => {
        checks += 1;
        return checks >= 4;
      },
      pollIntervalMs: 0,
    });

    expect(result.status).toBe("canceled");
    expect(cleanupHandle).toHaveBeenCalledWith(handle);
    expect(persistOutput).not.toHaveBeenCalled();
  });

  it("resumes a pending shot from its remote id without submitting again", async () => {
    const submit = vi.fn();
    const poll = vi.fn<VideoProvider["poll"]>().mockResolvedValue({
      status: "done",
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
      usage: { costUsdActual: 0.5 },
    });
    const persistOutput = vi.fn(async () => "shots/0/video.mp4");
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record: {
        ...createShotRecords([shot])[0]!,
        status: "pending",
        remoteId: "remote-resume",
      },
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput,
      pollIntervalMs: 0,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(persistOutput).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "succeeded",
      remoteId: "remote-resume",
      outputPath: "shots/0/video.mp4",
      costUsd: 0.5,
    });
  });

  it("does not re-submit a shot whose crash left the upstream state unknown", async () => {
    const handle: ProviderHandle = { providerId: "mock", remoteId: "remote-fresh" };
    const submit = vi.fn(async () => handle);
    const poll = vi.fn<VideoProvider["poll"]>().mockResolvedValue({
      status: "done",
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
    });
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      // `submitting` without a remote id: provider.submit may already have been billed.
      record: { ...createShotRecords([shot])[0]!, status: "submitting" },
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput: async () => "shots/0/video.mp4",
      pollIntervalMs: 0,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "needs_review", error: { code: "uncertain_submit" } });
  });

  it("resubmits a pending shot that never received a remote id", async () => {
    const handle: ProviderHandle = { providerId: "mock", remoteId: "remote-fresh" };
    const submit = vi.fn(async () => handle);
    const poll = vi.fn<VideoProvider["poll"]>().mockResolvedValue({
      status: "done",
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
    });
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record: { ...createShotRecords([shot])[0]!, status: "pending" },
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput: async () => "shots/0/video.mp4",
      pollIntervalMs: 0,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
  });

  it("does not call the provider when cancellation is already known", async () => {
    const submit = vi.fn();
    const poll = vi.fn();
    const states: HarnessShotRecord[] = [];
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models: { text_to_video: "mock-video", image_to_video: "mock-video", reference_to_video: "mock-video" },
      record: createShotRecords([shot])[0]!,
      provider: providerFor(submit, poll),
      resolveAsset,
      persistOutput: vi.fn(),
      isCanceled: async () => true,
      onState: async (state) => {
        states.push(state);
      },
    });
    expect(result.status).toBe("canceled");
    expect(submit).not.toHaveBeenCalled();
    expect(states.map((state) => state.status)).toEqual(["canceled"]);
  });
});

describe("shot executor — certain-rejection provider switch (N3.4)", () => {
  const models = {
    text_to_video: "mock-video",
    image_to_video: "mock-video",
    reference_to_video: "mock-video",
  };

  function donePoll(): VideoProvider["poll"] {
    return vi.fn<VideoProvider["poll"]>().mockResolvedValue({
      status: "done",
      progress: 100,
      remoteUrl: "http://fixture/video.mp4",
    });
  }

  it("moves a rejected shot to the next provider and records it on the record", async () => {
    const rejectedSubmit = vi.fn(async () => {
      throw new ProviderHttpError(429, "quota_exhausted", "out of credit");
    });
    const acceptedSubmit = vi.fn(async (): Promise<ProviderHandle> => ({
      providerId: "fixture-b",
      remoteId: "remote-b",
    }));
    const providerB = providerFor(acceptedSubmit, donePoll(), "fixture-b");
    const states: HarnessShotRecord[] = [];

    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models,
      record: createShotRecords([shot])[0]!,
      provider: providerFor(rejectedSubmit, vi.fn(), "fixture-a"),
      resolveAsset,
      persistOutput: async () => "shots/0/video.mp4",
      pollIntervalMs: 0,
      onState: async (state) => {
        states.push(state);
      },
      onCertainRejection: async (_error, _record, ctx) => ({
        provider: providerB,
        models: { ...models, text_to_video: "fixture-b-t2v" },
        shot: ctx.shot,
        excluded: [...ctx.excluded, ctx.provider.id],
      }),
    });

    expect(rejectedSubmit).toHaveBeenCalledTimes(1);
    expect(acceptedSubmit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "succeeded",
      provider: "fixture-b",
      model: "fixture-b-t2v",
      excludedProviders: ["fixture-a"],
    });
    // Poll used the *new* provider — the rejected one never sees this remote id.
    expect(providerB.poll).toHaveBeenCalled();
  });

  it("never switches on a read timeout — the submit may have been accepted", async () => {
    const submit = vi.fn(async () => {
      throw new ProviderHttpError(504, "upstream_timeout", "read timed out", {
        phase: "read",
      });
    });
    const onCertainRejection = vi.fn();
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models,
      record: createShotRecords([shot])[0]!,
      provider: providerFor(submit, vi.fn(), "fixture-a"),
      resolveAsset,
      persistOutput: vi.fn(),
      pollIntervalMs: 0,
      onCertainRejection,
    });

    expect(onCertainRejection).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "needs_review",
      error: { code: "uncertain_submit" },
    });
  });

  it("accumulates exclusions across rejections instead of retrying the same door", async () => {
    const reject = (id: string) =>
      vi.fn(async () => {
        throw new ProviderHttpError(401, "unauthorized", `${id} rejected the key`);
      });
    const submitA = reject("fixture-a");
    const submitB = reject("fixture-b");
    const submitC = vi.fn(async (): Promise<ProviderHandle> => ({
      providerId: "fixture-c",
      remoteId: "remote-c",
    }));
    const providers: Record<string, VideoProvider> = {
      "fixture-a": providerFor(submitA, vi.fn(), "fixture-a"),
      "fixture-b": providerFor(submitB, vi.fn(), "fixture-b"),
      "fixture-c": providerFor(submitC, donePoll(), "fixture-c"),
    };
    const hops: string[] = [];

    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models,
      record: createShotRecords([shot])[0]!,
      provider: providers["fixture-a"]!,
      resolveAsset,
      persistOutput: async () => "shots/0/video.mp4",
      pollIntervalMs: 0,
      onCertainRejection: async (_error, _record, ctx) => {
        const excluded = [...new Set([...ctx.excluded, ctx.provider.id])];
        const nextId = ["fixture-a", "fixture-b", "fixture-c"].find(
          (id) => !excluded.includes(id),
        );
        if (!nextId) return null;
        hops.push(`${ctx.provider.id}->${nextId}`);
        return { provider: providers[nextId]!, models, shot: ctx.shot, excluded };
      },
    });

    expect(submitA).toHaveBeenCalledTimes(1);
    expect(submitB).toHaveBeenCalledTimes(1);
    expect(submitC).toHaveBeenCalledTimes(1);
    expect(hops).toEqual(["fixture-a->fixture-b", "fixture-b->fixture-c"]);
    expect(result).toMatchObject({
      status: "succeeded",
      provider: "fixture-c",
      excludedProviders: ["fixture-a", "fixture-b"],
    });
  });

  it("treats an exhausted switch budget as a terminal rejection, not a retry", async () => {
    const submit = vi.fn(async () => {
      throw new ProviderHttpError(503, "upstream_rejected", "refused", {
        upstreamRejected: true,
      });
    });
    const result = await executeShotWithRetries({
      jobId: "job_harness",
      shot,
      bible,
      models,
      record: createShotRecords([shot])[0]!,
      provider: providerFor(submit, vi.fn(), "fixture-a"),
      resolveAsset,
      persistOutput: vi.fn(),
      pollIntervalMs: 0,
      // 换家名额已尽（RELAY_MAX_SWITCHES 由调用方计）：返回 null 走原失败路径。
      onCertainRejection: async () => null,
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "needs_review",
      retries: 0,
      error: { code: "upstream_rejected" },
    });
  });

  it("downgrades an r2v shot to i2v/t2v through the shared lockPlan rule", () => {
    const r2v: Shot = { ...shot, route: "r2v", characterIds: ["char_1"] };
    expect(downgradeR2vShot(r2v).route).toBe("t2v");
    expect(
      downgradeR2vShot({
        ...r2v,
        startFrame: { source: "generated", assetId: "shots/0/first.jpg" },
      }).route,
    ).toBe("i2v");
    expect(
      downgradeR2vShot({ ...r2v, continuity: "tail_chain" }).route,
    ).toBe("i2v");
    expect(downgradeR2vShot({ ...shot, route: "i2v" })).toEqual({
      ...shot,
      route: "i2v",
    });
  });
});
