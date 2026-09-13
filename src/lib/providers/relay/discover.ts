import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * `catalog.source:"models-endpoint"` 的目录快照：启动 30s 后首拉、之后按
 * `RELAY_CATALOG_REFRESH_MS` 周期刷新，管理接口 discover 也走同一函数；落到
 * `data/relay-catalog/<id>.json`。装配时目录 = 快照 ∪ 配置里的 `catalog.models`
 *（配置覆盖同名模型）。
 */

export type RelayCatalogSnapshot = {
  fetchedAt: string;
  /** 展示名 → 规格；上游回什么记什么，缺的字段用通用兜底补。 */
  models: Record<string, RelayModelSpec>;
};

export function relayCatalogSnapshotPath(id: string): string {
  return path.join(dataDir(), "relay-catalog", `${id}.json`);
}

// 快照读取按 mtime 记一行缓存：产品目录的缓存键每次都要拿表键集合，不能让它
// 每个请求都重新 parse 一遍文件。
const snapshotMemo = new Map<string, { mtime: number | null; models: Record<string, RelayModelSpec> }>();

/** 快照 → 目录表；文件不存在 / 坏掉都返回空表（不致命，目录退回纯配置）。 */
export function readRelayCatalogSnapshot(id: string): Record<string, RelayModelSpec> {
  const file = relayCatalogSnapshotPath(id);
  let mtime: number | null = null;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    mtime = null;
  }
  const hit = snapshotMemo.get(file);
  if (hit && hit.mtime === mtime) return hit.models;
  let models: Record<string, RelayModelSpec> = {};
  if (mtime !== null) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        models?: Record<string, RelayModelSpec>;
      };
      models = parsed.models && typeof parsed.models === "object" ? parsed.models : {};
    } catch {
      models = {};
    }
  }
  snapshotMemo.set(file, { mtime, models });
  return models;
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
  const specs: Record<string, RelayModelSpec> = {};
  const ids: string[] = [];
  for (const entry of list) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const raw = entry as Record<string, unknown>;
      const id = raw.id;
      if (typeof id === "string" && id.trim()) {
        const display = id.trim();
        ids.push(display);
        specs[display] = specFromUpstream(raw);
      }
    }
  }
  const before = new Set(currentTable);
  const after = new Set(ids);
  const snapshot: RelayCatalogSnapshot = {
    fetchedAt: new Date().toISOString(),
    models: specs,
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

const MODEL_KINDS = new Set(["video", "image", "chat"]);
const RATIO_RE = /^(\d+):(\d+)$/;

/**
 * `/models` 条目 → 目录规格。上游（new-api 系）会给 `kind` / `supported_ratios` /
 * `supported_resolutions` / `alias` / `canonical_id`，能给多少记多少；价目字段
 * `credits` 若是 `{resolution,duration}` 形状直接进档表，是裸数字当单次平价记。
 * 没给的字段回落 `UNKNOWN_RELAY_MODEL` 的通用兜底。
 */
function specFromUpstream(entry: Record<string, unknown>): RelayModelSpec {
  const fallback = UNKNOWN_RELAY_MODEL;
  const aliases = [entry.alias, entry.canonical_id]
    .filter((v): v is string => typeof v === "string" && Boolean(v.trim()) && v.trim() !== entry.id)
    .map((v) => v.trim());
  const ratios = Array.isArray(entry.supported_ratios)
    ? entry.supported_ratios.filter(
        (r): r is RelayModelSpec["ratios"][number] =>
          typeof r === "string" && RATIO_RE.test(r) && r !== "auto",
      )
    : undefined;
  const resolutions = Array.isArray(entry.supported_resolutions)
    ? [...new Set(
        entry.supported_resolutions
          .map((r) => (typeof r === "string" ? toRelayResolution(r) : undefined))
          .filter((r): r is "720p" | "1080p" => r !== undefined),
      )]
    : undefined;
  const credits = isRecord(entry.credits)
    ? {
        resolution: numberMap(entry.credits.resolution),
        duration: numberMap(entry.credits.duration),
      }
    : typeof entry.credits === "number" && Number.isFinite(entry.credits) && entry.credits >= 0
      ? { resolution: {}, duration: {}, flat: entry.credits }
      : undefined;
  return {
    aliases: aliases.length ? [...new Set(aliases)] : fallback.aliases,
    durations: fallback.durations,
    resolutions: resolutions?.length ? resolutions : fallback.resolutions,
    ratios: ratios?.length ? ratios : fallback.ratios,
    maxReferenceImages:
      typeof entry.max_reference_images === "number" && Number.isFinite(entry.max_reference_images)
        ? Math.max(0, Math.floor(entry.max_reference_images))
        : fallback.maxReferenceImages,
    kind:
      typeof entry.kind === "string" && MODEL_KINDS.has(entry.kind)
        ? (entry.kind as RelayModelSpec["kind"])
        : undefined,
    credits: {
      resolution: credits?.resolution ?? fallback.credits.resolution,
      duration: credits?.duration ?? fallback.credits.duration,
      flat: credits?.flat,
    },
  };
}

/** 上游的分辨率叫法 → 我们视频侧的两档。认不出返回 undefined（不落进档表）。 */
function toRelayResolution(raw: string): "720p" | "1080p" | undefined {
  const s = raw.trim().toLowerCase();
  if (/^(720|768|540|480)p?$/.test(s) || s === "1k") return "720p";
  if (/^(1080|1440|2160)p?$/.test(s) || s === "2k" || s === "4k") return "1080p";
  return undefined;
}

function numberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** discover 路由与启动拉取共用：写快照的原子版本（writeFileSync 的异步对等）。 */
export async function writeRelayCatalogSnapshot(
  id: string,
  snapshot: RelayCatalogSnapshot,
): Promise<void> {
  await writeJsonAtomic(relayCatalogSnapshotPath(id), snapshot);
}
