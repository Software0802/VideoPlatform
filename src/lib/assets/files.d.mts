import type { z } from "zod";
import type { CanvasNode } from "../canvas/schema";

export type AssetMetadata = {
  schemaVersion: 1;
  id: string;
  uploadId: string;
  ownerId: string;
  role: "start";
  width: number;
  height: number;
  bytes: number;
  mimeType: "image/jpeg";
  sha256: string;
  createdAt: string;
  expiresAt: string;
  purgedAt?: string;
};

export const ASSET_ID_RE: RegExp;
export const ASSET_RETENTION_MS: number;
export const assetSchema: z.ZodType<AssetMetadata>;
export class AssetUnavailableError extends Error {}
export function assetIdForUpload(uploadId: string): string;
export function assetFile(root: string, ownerId: string, assetId: string): string;
export function readAssetMetadata(root: string, ownerId: string, assetId: string): Promise<AssetMetadata | null>;
export function readAsset(root: string, ownerId: string, assetId: string, now?: number): Promise<{ metadata: AssetMetadata; bytes: Buffer } | null>;
export function promoteUploadAsset(root: string, ownerId: string, uploadId: string, options?: { now?: number; write?: boolean }): Promise<AssetMetadata>;
export function normalizeCanvasMaterials(root: string, ownerId: string, nodes: CanvasNode[], options?: {
  allowMissing?: boolean;
  existingNodes?: CanvasNode[];
  now?: number;
  write?: boolean;
}): Promise<CanvasNode[]>;
export function sweepAssets(root: string, now?: number): Promise<number>;
