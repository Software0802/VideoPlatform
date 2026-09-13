import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic, writeTextAtomic } from "../billing/file-ledger.mjs";

export const ASSET_ID_RE = /^as_[0-9a-f]{16}$/;
export const ASSET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OWNER_ID_RE = /^usr_[0-9a-f]{16}$/;
const UPLOAD_ID_RE = /^up_[0-9a-f]{16}$/;
const uploadSchema = z.object({
  uploadId: z.string().regex(UPLOAD_ID_RE),
  ownerId: z.string().regex(OWNER_ID_RE),
  role: z.literal("start"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  mimeType: z.literal("image/jpeg"),
});
export const assetSchema = uploadSchema.extend({
  schemaVersion: z.literal(1),
  id: z.string().regex(ASSET_ID_RE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  purgedAt: z.string().datetime().optional(),
}).strict();

export class AssetUnavailableError extends Error {
  constructor() {
    super("素材文件不存在或已过期");
    this.name = "AssetUnavailableError";
  }
}

export function assetIdForUpload(uploadId) {
  if (!UPLOAD_ID_RE.test(uploadId)) throw new AssetUnavailableError();
  return `as_${uploadId.slice(3)}`;
}

export function assetFile(root, ownerId, assetId) {
  if (!OWNER_ID_RE.test(ownerId) || !ASSET_ID_RE.test(assetId)) throw new AssetUnavailableError();
  return path.join(root, "assets", ownerId, assetId);
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readAssetMetadata(root, ownerId, assetId) {
  const raw = await readOptional(`${assetFile(root, ownerId, assetId)}.json`);
  if (!raw) return null;
  const parsed = assetSchema.safeParse(JSON.parse(raw.toString("utf8")));
  if (!parsed.success || parsed.data.id !== assetId || parsed.data.ownerId !== ownerId ||
      assetIdForUpload(parsed.data.uploadId) !== assetId) throw new AssetUnavailableError();
  return parsed.data;
}

export async function readAsset(root, ownerId, assetId, now = Date.now()) {
  const metadata = await readAssetMetadata(root, ownerId, assetId);
  if (!metadata || metadata.purgedAt || Date.parse(metadata.expiresAt) <= now) return null;
  const bytes = await readOptional(assetFile(root, ownerId, assetId));
  if (!bytes || bytes.length !== metadata.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) return null;
  return { metadata, bytes };
}

async function withAssetLock(root, fn) {
  const locks = globalThis.__lumenAssetLocks ??= new Map();
  const key = path.resolve(root);
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const tail = new Promise((resolve) => { release = resolve; });
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export async function promoteUploadAsset(root, ownerId, uploadId, { now = Date.now(), write = true } = {}) {
  return withAssetLock(root, async () => {
    const id = assetIdForUpload(uploadId);
    const existing = await readAssetMetadata(root, ownerId, id);
    if (existing) return existing;
    const source = path.join(root, "tmp", uploadId);
    const raw = await readOptional(`${source}.json`);
    if (!raw) throw new AssetUnavailableError();
    let parsed;
    try {
      parsed = uploadSchema.safeParse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw new AssetUnavailableError();
    }
    if (!parsed.success || parsed.data.uploadId !== uploadId || parsed.data.ownerId !== ownerId) {
      throw new AssetUnavailableError();
    }
    const bytes = await readOptional(source);
    if (!bytes || bytes.length !== parsed.data.bytes) throw new AssetUnavailableError();
    const metadata = assetSchema.parse({
      ...parsed.data,
      schemaVersion: 1,
      id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ASSET_RETENTION_MS).toISOString(),
    });
    if (write) {
      await writeTextAtomic(assetFile(root, ownerId, id), bytes);
      await writeJsonAtomic(`${assetFile(root, ownerId, id)}.json`, metadata);
    }
    return metadata;
  });
}

export async function normalizeCanvasMaterials(root, ownerId, nodes, {
  allowMissing = false, existingNodes = [], now = Date.now(), write = true,
} = {}) {
  const normalized = [];
  for (const node of nodes) {
    if (node.kind !== "material" || (!node.uploadId && !node.assetId)) {
      normalized.push(node);
      continue;
    }
    try {
      if (node.uploadId && node.assetId) throw new AssetUnavailableError();
      const asset = node.assetId
        ? await readAssetMetadata(root, ownerId, node.assetId)
        : await promoteUploadAsset(root, ownerId, node.uploadId, { now, write });
      if (!asset) throw new AssetUnavailableError();
      const expired = Date.parse(asset.expiresAt) <= now;
      const available = !write || await readAsset(root, ownerId, asset.id, now);
      normalized.push({
        ...node,
        uploadId: undefined,
        assetId: asset.id,
        assetExpiresAt: asset.expiresAt,
        assetState: expired ? "expired" : available ? "ready" : "missing",
      });
    } catch (error) {
      const alreadyMissing = existingNodes.some((old) => old.id === node.id && old.assetState === "missing" &&
        old.uploadId === node.uploadId && old.assetId === node.assetId);
      if (!(error instanceof AssetUnavailableError) || (!allowMissing && !alreadyMissing)) throw error;
      normalized.push({ ...node, assetState: "missing", assetExpiresAt: undefined });
    }
  }
  return normalized;
}

export async function sweepAssets(root, now = Date.now()) {
  return withAssetLock(root, async () => {
    const users = await readdir(path.join(root, "assets"), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let purged = 0;
    for (const user of users.filter((entry) => entry.isDirectory() && OWNER_ID_RE.test(entry.name))) {
      const names = await readdir(path.join(root, "assets", user.name));
      for (const name of names.filter((entry) => ASSET_ID_RE.test(entry.replace(/\.json$/, "")) && entry.endsWith(".json"))) {
        const id = name.slice(0, -5);
        const asset = await readAssetMetadata(root, user.name, id);
        if (!asset || asset.purgedAt || Date.parse(asset.expiresAt) > now) continue;
        await rm(assetFile(root, user.name, id), { force: true });
        await writeJsonAtomic(`${assetFile(root, user.name, id)}.json`, { ...asset, purgedAt: new Date(now).toISOString() });
        purged += 1;
      }
    }
    return purged;
  });
}
