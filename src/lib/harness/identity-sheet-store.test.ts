import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { persistIdentitySheet } from "./identity-sheet-store";
import type { IdentitySheetResult } from "./identity-sheet";

async function validJpeg() {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 160, b: 210 } },
  }).jpeg().toBuffer();
}

async function resultWith(bytes: Buffer): Promise<IdentitySheetResult> {
  return {
    characterId: "char_main",
    characterIndex: 0,
    requestJobId: "job_sheet_fixture-sheet-0",
    prompt: "fixture",
    handle: {
      providerId: "grok",
      remoteUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      costUsdActual: 0.02,
    },
  };
}

describe("identity sheet store", () => {
  it("atomically materializes a valid sheet under inputs/sheets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-sheet-store-test-"));
    const jobDir = path.join(root, "job");
    const tempDir = path.join(root, "tmp");
    try {
      const saved = await persistIdentitySheet(await resultWith(await validJpeg()), { jobDir, tempDir });
      expect(saved).toMatchObject({
        characterId: "char_main",
        assetId: "inputs/sheets/character-0.jpg",
      });
      expect((await stat(path.join(jobDir, "inputs/sheets/character-0.jpg"))).size).toBeGreaterThan(0);
      expect(await readdir(tempDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes staged bytes when cancellation wins the commit race", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-sheet-store-test-"));
    const jobDir = path.join(root, "job");
    const tempDir = path.join(root, "tmp");
    try {
      const saved = await persistIdentitySheet(await resultWith(await validJpeg()), {
        jobDir,
        tempDir,
        isCanceled: async () => true,
      });
      expect(saved).toBeNull();
      await expect(stat(path.join(jobDir, "inputs/sheets/character-0.jpg"))).rejects.toThrow();
      expect(await readdir(tempDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips remote materialization when already canceled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-sheet-store-test-"));
    const tempDir = path.join(root, "tmp");
    try {
      const saved = await persistIdentitySheet(await resultWith(Buffer.from("not-an-image")), {
        jobDir: path.join(root, "job"),
        tempDir,
        isCanceled: async () => true,
      });
      expect(saved).toBeNull();
      expect(await readdir(tempDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid image bytes and cleans the staging file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lumen-sheet-store-test-"));
    try {
      await expect(
        persistIdentitySheet(await resultWith(Buffer.from("not-an-image")), {
          jobDir: path.join(root, "job"),
          tempDir: path.join(root, "tmp"),
        }),
      ).rejects.toThrow();
      expect(await readdir(path.join(root, "tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
