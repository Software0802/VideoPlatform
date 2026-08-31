import { mkdtemp, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadToFile } from "./persist";

const ENV_KEYS = ["UPSTREAM_TIMEOUT_MS", "UPSTREAM_RETRY_BASE_MS"] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("media persistence", () => {
  it("aborts a hung remote URL download", async () => {
    process.env.UPSTREAM_TIMEOUT_MS = "5";
    process.env.UPSTREAM_RETRY_BASE_MS = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      ),
    );

    const testTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("test timeout")), 100),
    );
    await expect(
      Promise.race([downloadToFile("http://127.0.0.1:38123/video.mp4", "unused.mp4"), testTimeout]),
    ).rejects.toMatchObject({ code: "upstream_timeout" });
  });

  it("removes a partial destination when the response stream fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lumen-persist-test-"));
    const dest = path.join(dir, "partial.mp4");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        queueMicrotask(() => controller.error(new Error("fixture stream failed")));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    try {
      await expect(downloadToFile("http://127.0.0.1:38123/video.mp4", dest)).rejects.toThrow(
        "fixture stream failed",
      );
      await expect(access(dest)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
