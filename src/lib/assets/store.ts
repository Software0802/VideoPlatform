import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { storeUploadFromBuffer } from "@/lib/jobs/upload";
import type { CanvasNode } from "@/lib/canvas/schema";
import { ProviderHttpError } from "@/lib/providers/types";
import { AssetUnavailableError, assetIdForUpload, normalizeCanvasMaterials, readAsset, sweepAssets } from "./files.mjs";
import { migrateCanvasAssets } from "./migrate.mjs";

export async function retainCanvasMaterials(ownerId: string, nodes: CanvasNode[], existingNodes: CanvasNode[]): Promise<CanvasNode[]> {
  try {
    return await normalizeCanvasMaterials(dataDir(), ownerId, nodes, { existingNodes });
  } catch (error) {
    if (error instanceof AssetUnavailableError) {
      throw new ProviderHttpError(400, "input_missing", "素材文件不存在或已过期，请重新上传");
    }
    throw error;
  }
}

export async function readCanvasMaterial(ownerId: string, node: Pick<CanvasNode, "assetId" | "uploadId">) {
  try {
    const id = node.assetId ?? (node.uploadId ? assetIdForUpload(node.uploadId) : undefined);
    if (!id) throw new AssetUnavailableError();
    const asset = await readAsset(dataDir(), ownerId, id);
    if (!asset) throw new AssetUnavailableError();
    return asset;
  } catch (error) {
    if (error instanceof AssetUnavailableError) {
      throw new ProviderHttpError(400, node.assetId ? "input_missing" : "invalid_argument", "素材文件不存在或已过期，请重新上传");
    }
    throw error;
  }
}

export async function copyCanvasMaterial(ownerId: string, node: Pick<CanvasNode, "assetId" | "uploadId">) {
  const { bytes } = await readCanvasMaterial(ownerId, node);
  return storeUploadFromBuffer(bytes, "start", ownerId);
}

type AssetState = typeof globalThis & { __lumenAssetMaintenance?: ReturnType<typeof setInterval> };

export async function initializeCanvasAssets(): Promise<void> {
  const root = dataDir();
  const result = await migrateCanvasAssets(root, { write: true });
  if (result.changed || result.missing) log("info", "canvas asset migration", result);
  await sweepAssets(root);
  const state = globalThis as AssetState;
  if (state.__lumenAssetMaintenance) return;
  state.__lumenAssetMaintenance = setInterval(() => {
    void sweepAssets(root).catch((error) => log("warn", "canvas asset retention failed", {
      msg: error instanceof Error ? error.message : String(error),
    }));
  }, 60 * 60 * 1000);
  state.__lumenAssetMaintenance.unref();
}
