import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { commitLocalOutput, resolveLocalOutput } from "@/lib/jobs/local-output";
import { persistRemote } from "@/lib/media/persist";
import { mediaStore } from "@/lib/storage/local-fs";
import type { ProviderHandle, ProviderId } from "@/lib/providers/types";
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

  const assetId = `inputs/sheets/character-${result.characterIndex}-${result.view ?? "front"}.jpg`;
  const persisted = await persistGeneratedImage(
    result.handle,
    result.requestJobId,
    assetId,
    options,
  );
  if (!persisted) return null;
  return {
    characterId: result.characterId,
    characterIndex: result.characterIndex,
    assetId,
    path: persisted.path,
    width: persisted.width,
    height: persisted.height,
    costUsdActual: result.handle.costUsdActual,
  };
}

/**
 * 一次生图调用产物的通用落盘：远端 URL / fileId 下载，或 mock 这类直接落在
 * `requestJobId` 任务目录 `localVideoPath` 的本地文件；统一归一成 JPEG 后原子提交到
 * `assetId`。角色表与每镜首帧共用这一条。
 */
export async function persistGeneratedImage(
  handle: ProviderHandle,
  requestJobId: string,
  assetId: string,
  options: IdentitySheetStoreOptions,
): Promise<{ path: string; width: number; height: number } | null> {
  const destination = resolveLocalOutput(options.jobDir, assetId);
  await mkdir(options.tempDir, { recursive: true });
  const staged = path.join(
    options.tempDir,
    `generated-image-${randomBytes(8).toString("hex")}.jpg`,
  );
  const isCanceled = options.isCanceled ?? (async () => false);

  try {
    if (await isCanceled()) return null;
    if (handle.localVideoPath) {
      // requestJobId 是兄弟任务目录（provider 按 jobId 分目录暂存）。
      const src = resolveLocalOutput(mediaStore.jobDir(requestJobId), handle.localVideoPath);
      await copyFile(src, staged);
    } else {
      await persistRemote({
        dest: staged,
        remoteUrl: handle.remoteUrl,
        fileId: handle.fileOutputId,
        providerId: options.providerId,
      });
    }
    const normalized = await normalizeImage(staged);
    await writeFile(staged, normalized.bytes);
    const committed = await commitLocalOutput(staged, destination, isCanceled);
    if (!committed) return null;
    return { path: destination, width: normalized.width, height: normalized.height };
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

async function normalizeImage(file: string): Promise<{ bytes: Buffer; width: number; height: number }> {
  const source = await readFile(file);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw new Error("生成的图片无效");
  const bytes = await sharp(source).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { bytes, width: metadata.width, height: metadata.height };
}
