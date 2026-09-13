import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { log } from "@/lib/log";
import { relayGet } from "@/lib/providers/relay/client";
import {
  UNKNOWN_RELAY_MODEL,
  type RelayModelSpec,
} from "@/lib/providers/relay/catalog";
import type { RelayView } from "@/lib/providers/relay/live";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";

/**
 * `catalog.source:"models-endpoint"` 的目录快照：启动 30s 后与管理接口 discover
 * 各拉一次 `GET {base}/models`，落到 `data/relay-catalog/<id>.json`。装配时目录 =
 * 快照 ∪ 配置里的 `catalog.models`（配置覆盖同名模型）。
 * 周期刷新与「模型消失」告警留给 N3.3。
 */

export type RelayCatalogSnapshot = {
  fetchedAt: string;
  /** 展示名 → 规格；快照里的模型只认得 id，规格一律用通用兜底。 */
  models: Record<string, RelayModelSpec>;
};

export function relayCatalogSnapshotPath(id: string): string {
  return path.join(dataDir(), "relay-catalog", `${id}.json`);
}

/** 快照 → 目录表；文件不存在 / 坏掉都返回空表（不致命，目录退回纯配置）。 */
export function readRelayCatalogSnapshot(id: string): Record<string, RelayModelSpec> {
  const file = relayCatalogSnapshotPath(id);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      models?: Record<string, RelayModelSpec>;
    };
    return parsed.models && typeof parsed.models === "object" ? parsed.models : {};
  } catch {
    return {};
  }
}

export function relayCatalogSnapshotFetchedAt(id: string): string | undefined {
  const file = relayCatalogSnapshotPath(id);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { fetchedAt?: string };
    return typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : undefined;
  } catch {
    return undefined;
  }
}

export type DiscoverResult = {
  fetchedAt: string;
  /** 上游 `/models` 返回的全部 id（原始顺序）。 */
  models: string[];
  /** 相对装配前目录的新增 / 消失（只按 id 比）。 */
  diff: { added: string[]; removed: string[] };
};

/**
 * 拉一次 `/models` 并写快照。返回的 diff 相对 `currentTable`（调用方传装配前
 * 生效的目录键集合）；失败抛错不写快照——旧快照继续生效比清空强。
 */
export async function fetchRelayModels(
  view: RelayView,
  currentTable: string[] = [],
): Promise<DiscoverResult> {
  const data = await relayGet(view, "/models");
  const list = Array.isArray(data.data) ? data.data : [];
  const ids: string[] = [];
  for (const entry of list) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  const before = new Set(currentTable);
  const after = new Set(ids);
  const snapshot: RelayCatalogSnapshot = {
    fetchedAt: new Date().toISOString(),
    models: Object.fromEntries(ids.map((id) => [id, UNKNOWN_RELAY_MODEL])),
  };
  try {
    mkdirSync(path.dirname(relayCatalogSnapshotPath(view.id)), { recursive: true });
    writeFileSync(
      relayCatalogSnapshotPath(view.id),
      JSON.stringify(snapshot, null, 2),
      "utf8",
    );
  } catch (error) {
    log("warn", "relay 目录快照写盘失败（本次结果仍返回）", {
      relay: view.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    fetchedAt: snapshot.fetchedAt,
    models: ids,
    diff: {
      added: ids.filter((id) => !before.has(id)),
      removed: [...before].filter((id) => !after.has(id)),
    },
  };
}

/** discover 路由与启动拉取共用：写快照的原子版本（writeFileSync 的异步对等）。 */
export async function writeRelayCatalogSnapshot(
  id: string,
  snapshot: RelayCatalogSnapshot,
): Promise<void> {
  await writeJsonAtomic(relayCatalogSnapshotPath(id), snapshot);
}
