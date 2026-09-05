import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_OWNER = "usr_00000000000000a1";

let dataRoot = "";
let createJob: (
  body: {
    mode: "text_to_image";
    prompt: string;
    idempotencyKey?: string;
  },
  ownerId: string,
) => Promise<{ job: { id: string }; replay: boolean }>;
let activeCount: () => Promise<number>;

beforeAll(async () => {
  dataRoot = await mkdtemp(`${os.tmpdir()}\\lumen-admission-test-`);
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  process.env.MAX_QUEUED_JOBS = "1";
  ({ createJob } = await import("./create"));
  ({ activeCount } = await import("./runner"));
});

afterAll(async () => {
  await waitForIdle();
  await rm(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  delete process.env.MAX_QUEUED_JOBS;
});

async function waitForIdle() {
  for (let i = 0; i < 30; i += 1) {
    if ((await activeCount?.()) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("job admission", () => {
  it("admits at most the configured number of concurrent jobs", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createJob({ mode: "text_to_image", prompt: "one" }, TEST_OWNER)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    await waitForIdle();
  });

  it("replays one job for concurrent requests with the same idempotency key", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createJob({ mode: "text_to_image", prompt: "same", idempotencyKey: "same-key" }, TEST_OWNER),
      ),
    );

    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(results.filter((result) => result.replay)).toHaveLength(7);
  });
});
