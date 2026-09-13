import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeCanvasMaterials } from "./files.mjs";
import { writeJsonAtomic } from "../billing/file-ledger.mjs";

export async function migrateCanvasAssets(root, { write = false, now = Date.now() } = {}) {
  const result = { canvases: 0, changed: 0, missing: 0, activeRuns: 0 };
  for (const kind of ["canvases", "canvas-runs"]) {
    const dir = kind === "canvases" ? path.join(root, "canvases") : path.join(root, "canvas-runs");
    const users = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const user of users.filter((entry) => entry.isDirectory() && /^usr_[0-9a-f]{16}$/.test(entry.name))) {
      const names = await readdir(path.join(dir, user.name));
      const pattern = kind === "canvases" ? /^cv_[0-9a-f]{12}\.json$/ : /^crun_[0-9a-f]{12}\.json$/;
      for (const name of names.filter((entry) => pattern.test(entry))) {
        const file = path.join(dir, user.name, name);
        const doc = JSON.parse(await readFile(file, "utf8"));
        if (doc.ownerId !== user.name || doc.id !== name.slice(0, -5) || doc.schemaVersion !== 1) {
          throw new Error("画布素材迁移遇到无效文档");
        }
        const isCanvas = kind === "canvases";
        if (!isCanvas && doc.status !== "running") continue;
        const original = isCanvas ? doc.nodes : doc.graphSnapshot?.nodes;
        if (!Array.isArray(original) || (isCanvas && !Number.isInteger(doc.revision))) {
          throw new Error("画布素材迁移遇到无效节点或版本号");
        }
        const nodes = await normalizeCanvasMaterials(root, user.name, original, { allowMissing: true, now, write });
        result.missing += nodes.filter((node) => node.assetState === "missing").length;
        if (!isCanvas) {
          result.activeRuns += 1;
          continue;
        }
        result.canvases += 1;
        if (JSON.stringify(nodes) === JSON.stringify(original)) continue;
        result.changed += 1;
        if (write) {
          await writeJsonAtomic(file, { ...doc, nodes, revision: doc.revision + 1, updatedAt: new Date(now).toISOString() });
        }
      }
    }
  }
  return result;
}
