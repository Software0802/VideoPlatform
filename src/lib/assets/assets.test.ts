import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_RETENTION_MS, AssetUnavailableError, assetFile, assetIdForUpload, normalizeCanvasMaterials, promoteUploadAsset, readAsset, readAssetMetadata, sweepAssets } from "./files.mjs";
import { migrateCanvasAssets } from "./migrate.mjs";
import { storeUploadFromBuffer } from "@/lib/jobs/upload";
import { nodeInputHash } from "@/lib/canvas/graph";
import { GET } from "@/app/api/uploads/[id]/route";

const session = vi.hoisted(() => ({ id: "usr_0000000000000501" }));
vi.mock("@/lib/users/session", () => ({ requireUser: async () => ({ id: session.id }) }));

const OWNER = "usr_0000000000000501";
const OTHER = "usr_0000000000000502";
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lumen-assets-"));
  vi.stubEnv("DATA_DIR", root);
  vi.stubEnv("LUMEN_FORCE_MOCK", "1");
  session.id = OWNER;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function upload() {
  const image = await sharp({
    create: { width: 4, height: 3, channels: 3, background: { r: 20, g: 50, b: 80 } },
  }).jpeg().toBuffer();
  return storeUploadFromBuffer(image, "start", OWNER);
}

function material(uploadId: string) {
  return { id: "n_00000001", kind: "material" as const, x: 0, y: 0, uploadId };
}

function response(id: string) {
  return GET(new Request(`http://localhost/api/uploads/${id}`), { params: Promise.resolve({ id }) });
}

describe("canvas assets", () => {
  it("copies once under concurrent promotion and never renews the original expiry", async () => {
    const source = await upload();
    const [first, again] = await Promise.all([
      promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW }),
      promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW + 1000 }),
    ]);
    expect(first).toEqual(again);
    expect(Date.parse(first.expiresAt)).toBe(NOW + ASSET_RETENTION_MS);
    expect((await readdir(path.join(root, "assets", OWNER))).sort()).toEqual([first.id, `${first.id}.json`]);
    const later = await promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW + ASSET_RETENTION_MS + 1 });
    expect(later).toEqual(first);
    expect(await readAsset(root, OWNER, first.id, NOW + ASSET_RETENTION_MS - 1)).not.toBeNull();
    expect(await readAsset(root, OWNER, first.id, NOW + ASSET_RETENTION_MS)).toBeNull();
  });

  it("purges expired bytes while retaining an expiry tombstone", async () => {
    const source = await upload();
    const asset = await promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW });
    expect(await sweepAssets(root, NOW + ASSET_RETENTION_MS - 1)).toBe(0);
    expect(await sweepAssets(root, NOW + ASSET_RETENTION_MS)).toBe(1);
    expect(await sweepAssets(root, NOW + ASSET_RETENTION_MS + 1)).toBe(0);
    await expect(readFile(assetFile(root, OWNER, asset.id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readAssetMetadata(root, OWNER, asset.id)).toMatchObject({ expiresAt: asset.expiresAt, purgedAt: asset.expiresAt });
    expect(await promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW + 2 * ASSET_RETENTION_MS })).toMatchObject({ expiresAt: asset.expiresAt });
  });

  it("rejects foreign uploads and unsafe ids without exposing another owner's bytes", async () => {
    const source = await upload();
    const asset = await promoteUploadAsset(root, OWNER, source.uploadId);
    expect(await readAsset(root, OTHER, asset.id)).toBeNull();
    await expect(promoteUploadAsset(root, OTHER, source.uploadId)).rejects.toBeInstanceOf(AssetUnavailableError);
    await expect(promoteUploadAsset(root, "../users", source.uploadId)).rejects.toBeInstanceOf(AssetUnavailableError);
    expect(() => assetIdForUpload("../../secret")).toThrow(AssetUnavailableError);
  });

  it("rejects changed content and preserves server-owned expiry fields on canvas saves", async () => {
    const source = await upload();
    const asset = await promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW });
    const nodes = await normalizeCanvasMaterials(root, OWNER, [{
      id: "n_00000001", kind: "material", x: 0, y: 0, assetId: asset.id,
      assetState: "ready", assetExpiresAt: "2099-01-01T00:00:00.000Z",
    }], { now: NOW + ASSET_RETENTION_MS });
    expect(nodes[0]).toMatchObject({ assetState: "expired", assetExpiresAt: asset.expiresAt });
    await writeFile(assetFile(root, OWNER, asset.id), "changed bytes");
    expect(await readAsset(root, OWNER, asset.id, NOW)).toBeNull();
  });

  it("keeps content-addressed graph inputs stable across upload-to-asset migration", async () => {
    const source = await upload();
    const nodes = [material(source.uploadId), { id: "n_00000002", kind: "gen_video" as const, x: 300, y: 0, prompt: "move" }];
    const edges = [{ id: "e_00000001", from: nodes[0].id, to: nodes[1].id }];
    const normalized = await normalizeCanvasMaterials(root, OWNER, nodes);
    expect(normalized[0]).toMatchObject({ assetId: assetIdForUpload(source.uploadId), assetState: "ready" });
    expect(normalized[0].uploadId).toBeUndefined();
    expect(nodeInputHash({ nodes: normalized, edges }, nodes[1].id)).toBe(nodeInputHash({ nodes, edges }, nodes[1].id));
  });
});

describe("asset migration", () => {
  it("previews without writes, migrates legacy and missing references, and replays without changing bytes", async () => {
    const source = await upload();
    const doc = {
      schemaVersion: 1, id: "cv_000000000001", ownerId: OWNER, title: "legacy", revision: 7,
      nodes: [material(source.uploadId), { ...material("up_0000000000000000"), id: "n_00000003" }],
      edges: [], createdAt: new Date(NOW - 1000).toISOString(), updatedAt: new Date(NOW - 1000).toISOString(),
    };
    const file = path.join(root, "canvases", OWNER, `${doc.id}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify(doc);
    await writeFile(file, original);
    expect(await migrateCanvasAssets(root, { now: NOW })).toMatchObject({ canvases: 1, changed: 1, missing: 1 });
    expect(await readFile(file, "utf8")).toBe(original);
    await expect(readdir(path.join(root, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await migrateCanvasAssets(root, { write: true, now: NOW })).toMatchObject({ changed: 1, missing: 1 });
    const updated = await readFile(file, "utf8");
    const migrated = JSON.parse(updated);
    expect(migrated).toMatchObject({ revision: 8, title: doc.title, createdAt: doc.createdAt });
    expect(migrated.nodes[0]).toMatchObject({ assetId: assetIdForUpload(source.uploadId), assetState: "ready" });
    expect(migrated.nodes[1]).toMatchObject({ assetState: "missing" });
    expect(await migrateCanvasAssets(root, { write: true, now: NOW + 1000 })).toMatchObject({ changed: 0 });
    expect(await readFile(file, "utf8")).toBe(updated);
    await expect(normalizeCanvasMaterials(root, OWNER, migrated.nodes, { existingNodes: migrated.nodes, now: NOW })).resolves.toEqual(migrated.nodes);
  });

  it("protects active-run uploads without rewriting frozen inputs, quotes or reservations", async () => {
    const source = await upload();
    const run = {
      schemaVersion: 1, id: "crun_000000000001", ownerId: OWNER, status: "running",
      graphSnapshot: { nodes: [material(source.uploadId)], edges: [] },
      quote: { hash: "original-quote" }, reservation: { amountCny: 10 },
    };
    const file = path.join(root, "canvas-runs", OWNER, `${run.id}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify(run);
    await writeFile(file, original);
    expect(await migrateCanvasAssets(root, { write: true, now: NOW })).toMatchObject({ activeRuns: 1 });
    expect(await readFile(file, "utf8")).toBe(original);
    await rm(path.join(root, "tmp", source.uploadId));
    expect(await readAsset(root, OWNER, assetIdForUpload(source.uploadId), NOW)).not.toBeNull();
  });
});

describe("owned asset media route", () => {
  it("serves durable and temporary images with private revalidation and denies another owner", async () => {
    const source = await upload();
    const asset = await promoteUploadAsset(root, OWNER, source.uploadId);
    for (const id of [source.uploadId, asset.id]) {
      const own = await response(id);
      expect(own.status).toBe(200);
      expect(own.headers.get("cache-control")).toBe("private, no-cache");
      expect(own.headers.get("content-type")).toBe("image/jpeg");
      session.id = OTHER;
      expect((await response(id)).status).toBe(404);
      session.id = OWNER;
    }
  });

  it("returns 404 for expired or tampered assets and keeps the response indistinguishable from missing", async () => {
    const source = await upload();
    const asset = await promoteUploadAsset(root, OWNER, source.uploadId, { now: NOW });
    vi.spyOn(Date, "now").mockReturnValue(NOW + ASSET_RETENTION_MS);
    const expired = await response(asset.id);
    const missing = await response("as_0000000000000000");
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual(await missing.json());
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await writeFile(assetFile(root, OWNER, asset.id), "not the original image");
    expect((await response(asset.id)).status).toBe(404);
  });
});
