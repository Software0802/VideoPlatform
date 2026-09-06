import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { commitLocalOutput, resolveLocalOutput } from "@/lib/jobs/local-output";
import { persistRemote } from "@/lib/media/persist";
import type { ProviderId } from "@/lib/providers/types";
import type { IdentitySheetResult } from "./identity-sheet";

export type IdentitySheetAsset = {
  characterId: string;
  characterIndex: number;
  assetId: string;
  path: string;
  width: number;
  height: number;
  costUsdActual?: number;
};

export type IdentitySheetStoreOptions = {
  jobDir: string;
  tempDir: string;
  isCanceled?: () => Promise<boolean>;
  /** 角色表出自哪家上游；下载鉴权头按它绑定（见 `media/download-headers.ts`）。 */
  providerId?: ProviderId;
};

export async function persistIdentitySheet(
  result: IdentitySheetResult,
  options: IdentitySheetStoreOptions,
): Promise<IdentitySheetAsset | null> {
  if (!Number.isInteger(result.characterIndex) || result.characterIndex < 0) {
    throw new Error("角色表索引无效");
  }
  if (!result.characterId.trim()) throw new Error("角色表角色无效");

  const assetId = `inputs/sheets/character-${result.characterIndex}.jpg`;
  const destination = resolveLocalOutput(options.jobDir, assetId);
  await mkdir(options.tempDir, { recursive: true });
  const staged = path.join(
    options.tempDir,
    `identity-sheet-${result.characterIndex}-${randomBytes(8).toString("hex")}.jpg`,
  );
  const isCanceled = options.isCanceled ?? (async () => false);

  try {
    if (await isCanceled()) return null;
    await persistRemote({
      dest: staged,
      remoteUrl: result.handle.remoteUrl,
      fileId: result.handle.fileOutputId,
      providerId: options.providerId,
    });
    const normalized = await normalizeImage(staged);
    await writeFile(staged, normalized.bytes);
    const committed = await commitLocalOutput(staged, destination, isCanceled);
    if (!committed) return null;
    return {
      characterId: result.characterId,
      characterIndex: result.characterIndex,
      assetId,
      path: destination,
      width: normalized.width,
      height: normalized.height,
      costUsdActual: result.handle.costUsdActual,
    };
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

async function normalizeImage(file: string): Promise<{ bytes: Buffer; width: number; height: number }> {
  const source = await readFile(file);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw new Error("角色表图片无效");
  const bytes = await sharp(source).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { bytes, width: metadata.width, height: metadata.height };
}
