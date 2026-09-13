import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "build-info-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  // buildInfo() 结果按进程缓存，每个用例都需要一份全新模块。
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  shortSha: "0123456",
  builtAt: "2026-09-14T04:00:00.000Z",
  node: "v24.16.0",
  dirty: false,
};

describe("buildInfo", () => {
  it("returns the parsed payload when BUILD_INFO.json is valid", async () => {
    writeFileSync(path.join(dir, "BUILD_INFO.json"), JSON.stringify(VALID));
    const { buildInfo } = await import("./build-info");
    expect(buildInfo()).toEqual(VALID);
  });

  it("returns null when BUILD_INFO.json is missing (dev / local builds)", async () => {
    const { buildInfo } = await import("./build-info");
    expect(buildInfo()).toBeNull();
  });

  it("returns null on malformed JSON and on schema mismatch", async () => {
    writeFileSync(path.join(dir, "BUILD_INFO.json"), "{not json");
    let { buildInfo } = await import("./build-info");
    expect(buildInfo()).toBeNull();

    vi.resetModules();
    writeFileSync(path.join(dir, "BUILD_INFO.json"), JSON.stringify({ sha: 1 }));
    ({ buildInfo } = await import("./build-info"));
    expect(buildInfo()).toBeNull();
  });

  it("caches the result: the file is read once per process", async () => {
    const { buildInfo } = await import("./build-info");
    expect(buildInfo()).toBeNull();
    writeFileSync(path.join(dir, "BUILD_INFO.json"), JSON.stringify(VALID));
    expect(buildInfo()).toBeNull();
  });
});
