// @ts-check
import { parseArgs } from "node:util";
import path from "node:path";
import { migrateCanvasAssets } from "../src/lib/assets/migrate.mjs";

try {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      write: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("用法: node scripts/migrate-canvas-assets.mjs [--data-dir DIR] [--write --offline]；默认只读预检");
  } else {
    if (values.write && !values.offline) throw new Error("写入迁移必须确认服务已停，并传 --write --offline");
    const root = path.resolve(values["data-dir"] ?? process.env.DATA_DIR ?? "data");
    const result = await migrateCanvasAssets(root, { write: values.write });
    console.log(JSON.stringify({ dryRun: !values.write, ...result }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
