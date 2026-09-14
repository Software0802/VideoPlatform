import { z } from "zod";
import {
  loadRelaysDetailed,
  readRelaysFile,
  relaysFileExists,
  relayConfigSchema,
  writeRelays,
  modelSpecSchema,
  type RelayConfig,
} from "@/lib/providers/relay/config";
import { reconcileRelays, currentRelayViews } from "@/lib/providers/relay/assemble";
import { withRelayLock } from "@/lib/providers/relay/lock";
import { healthList } from "@/lib/providers/health";
import {
  readRelayCatalogSnapshot,
  relayCatalogSnapshotFetchedAt,
} from "@/lib/providers/relay/discover";
import {
  mergeModelTables,
  relayModelDisplayName,
  type RelayModelSpec,
} from "@/lib/providers/relay/catalog";
import type { RelayView } from "@/lib/providers/relay/live";
import type { ProductPriceOverride } from "@/lib/billing/prices";
import {
  generatedRelayProducts,
  relayModelPinnedByDefault,
} from "@/lib/products/catalog";
import { isRegisteredProviderId } from "@/lib/providers/registry";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * 管理接口背后的读写层：只操作 `data/relays.json` 里的**显式条目**。
 * env 折算的 yman / openai 预设不在文件里，PATCH / DELETE 它们会得到 404——
 * 要改它们就在文件里写一条同 id 的配置（`desiredRelayEntries` 会让文件赢预设）。
 *
 * 任何响应字段都不含 key 值：对外只给 `keyEnv` 名与 `hasKey` 布尔。
 */

export type RelaySummary = {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string;
  hasKey: boolean;
  enabled: boolean;
  priority: number;
  registered: boolean;
  source: "file" | "env-seed" | "legacy";
  channels: { video: boolean; image: boolean; chat: boolean };
  catalogSource: "static" | "models-endpoint" | null;
  catalogSnapshotAt: string | undefined;
  /** 视频 / 图片通道的健康态（`providers/health.ts`），没有的通道为 undefined。 */
  health: { video?: "ok" | "cooldown" | "half-open"; image?: "ok" | "cooldown" | "half-open" };
  /** 是否由文件管理（false = env 预设，PATCH/DELETE 不适用）。 */
  managed: boolean;
  /**
   * 模型目录明细（管理页「模型表」）：快照 ∪ 配置深合并后的每模型视图。
   * `listed` = 此刻会生成为产品（非 hidden、价已给、kind≠chat、未被默认产品表钉住）。
   * legacy 预设也返回（`managed:false` 时页面只读）。
   */
  catalog?: {
    source: "static" | "models-endpoint";
    snapshotAt?: string;
    /** 「转为可管理条目」要用的通道底稿（视频默认模型 / 生图模型名）。 */
    videoDefaults: Partial<Record<"text_to_video" | "image_to_video" | "reference_to_video", string>>;
    imageModel?: string;
    models: RelayCatalogModelEntry[];
  };
};

export type RelayCatalogModelEntry = {
  /** 目录键 = 上游模型 id（发出去的名字）。 */
  id: string;
  kind?: "video" | "image" | "chat";
  /** 上游 `/models` 给的展示名（快照字段）。 */
  upstreamName?: string;
  /** 配置里给用户看的展示名（解析顺序 name → upstreamName → id）。 */
  name?: string;
  /** 解析后的展示名（产品名就是它）。 */
  displayName: string;
  hidden?: boolean;
  price?: ProductPriceOverride;
  durations: number[];
  resolutions: string[];
  ratios: string[];
  maxReferenceImages: number;
  credits?: RelayModelSpec["credits"];
  fromSnapshot: boolean;
  fromConfig: boolean;
  /** 默认产品表已钉住这个模型（不再生成重复产品）。 */
  defaultPinned: boolean;
  listed: boolean;
};

function catalogDetailOf(view: RelayView, fileCfg: RelayConfig | undefined): RelaySummary["catalog"] {
  if (!view.catalog) return undefined;
  const configModels = (fileCfg?.catalog?.models ?? {}) as Record<string, RelayModelSpec>;
  const snapshot = view.catalogSource === "models-endpoint" ? readRelayCatalogSnapshot(view.id) : {};
  const table = mergeModelTables(snapshot, configModels);
  // static 目录没有快照层：配置表就是全部认知；legacy 预设读视图自己的表。
  const entries = Object.keys(table).length
    ? table
    : (view.catalog.table() as Record<string, RelayModelSpec>);
  const listed = new Map(
    generatedRelayProducts()
      .filter((p) => p.provider === view.id && p.upstreamModel)
      .map((p) => [p.upstreamModel!, p.id]),
  );
  const models: RelayCatalogModelEntry[] = Object.entries(entries).map(([id, spec]) => ({
    id,
    kind: spec.kind,
    upstreamName: spec.upstreamName,
    name: spec.name,
    displayName: relayModelDisplayName(id, spec),
    hidden: spec.hidden,
    price: spec.price,
    durations: spec.durations ?? [],
    resolutions: spec.resolutions ?? [],
    ratios: spec.ratios ?? [],
    maxReferenceImages: spec.maxReferenceImages ?? 0,
    credits: spec.credits,
    fromSnapshot: Boolean(snapshot[id]),
    fromConfig: Boolean(configModels[id]),
    defaultPinned: relayModelPinnedByDefault(view, id),
    listed: listed.has(id),
  }));
  return {
    source: view.catalogSource ?? "static",
    snapshotAt: relayCatalogSnapshotFetchedAt(view.id),
    videoDefaults: {
      text_to_video: fileCfg?.video?.defaults.text_to_video ?? view.catalog.configuredModel("text_to_video"),
      image_to_video: fileCfg?.video?.defaults.image_to_video ?? view.catalog.configuredModel("image_to_video"),
      reference_to_video:
        fileCfg?.video?.defaults.reference_to_video ?? view.catalog.configuredModel("reference_to_video"),
    },
    imageModel: fileCfg?.image?.model ?? view.image?.model(),
    models,
  };
}

export function listRelays(): RelaySummary[] {
  const fileList = relaysFileExists() ? readRelaysFile() : [];
  const fileIds = new Set(fileList.map((r) => r.id));
  const fileById = new Map(fileList.map((r) => [r.id, r]));
  return currentRelayViews().map((view) => ({
    id: view.id,
    name: view.name,
    baseUrl: view.base(),
    keyEnv: view.keyEnvName,
    hasKey: Boolean(view.apiKey()),
    enabled: view.enabled,
    priority: view.priority,
    registered: isRegisteredProviderId(view.id),
    source: view.source,
    channels: {
      video: Boolean(view.catalog),
      image: Boolean(view.image),
      chat: Boolean(view.chatModel()),
    },
    catalogSource: view.catalog ? (view.catalogSource ?? "static") : null,
    catalogSnapshotAt: relayCatalogSnapshotFetchedAt(view.id),
    health: {
      video: view.catalog ? healthStateFor(view.id, "video") : undefined,
      image: view.image ? healthStateFor(view.id, "image") : undefined,
    },
    managed: fileIds.has(view.id),
    catalog: catalogDetailOf(view, fileById.get(view.id)),
  }));
}

function healthStateFor(id: string, kind: "video" | "image"): "ok" | "cooldown" | "half-open" {
  return healthList().find((h) => h.providerId === id && h.kind === kind)?.state ?? "ok";
}

function fileRelays(): RelayConfig[] {
  return relaysFileExists() ? readRelaysFile() : [];
}

export async function createRelay(body: unknown): Promise<RelaySummary> {
  const cfg = relayConfigSchema.parse(body);
  // 读→判重→写整个临界区进锁：两个并发 create 各读各的旧文件再各写各的，后写者会丢掉先写者。
  return withRelayLock(async () => {
    const relays = fileRelays();
    if (relays.some((r) => r.id === cfg.id)) {
      throw new ProviderHttpError(409, "relay_exists", `relay ${cfg.id} 已存在`);
    }
    await writeRelays([...relays, cfg]);
    reconcileRelays();
    return summaryOf(cfg.id);
  });
}

/**
 * PATCH 形状：`catalog.models` 是**按模型的部分更新**——只替换给到的键，其它模型
 * 的配置保留；某个模型传 `null` 表示删掉它的配置覆盖（模型本身若来自快照仍存在）。
 */
const patchSchema = relayConfigSchema.partial().omit({ id: true, catalog: true }).extend({
  catalog: z
    .object({
      source: z.enum(["static", "models-endpoint"]).optional(),
      models: z.record(z.string(), modelSpecSchema.nullable()).optional(),
      unknownCredits: z.number().positive().optional(),
    })
    .optional(),
});

export async function updateRelay(id: string, body: unknown): Promise<RelaySummary> {
  const patch = patchSchema.parse(body);
  return withRelayLock(async () => {
    const relays = fileRelays();
    const index = relays.findIndex((r) => r.id === id);
    if (index < 0) {
      throw new ProviderHttpError(404, "not_found", `relay ${id} 不存在（env 预设不由接口管理）`);
    }
    const prev = relays[index];
    const catalog = mergeCatalogPatch(prev.catalog, patch.catalog);
    const merged = relayConfigSchema.parse({ ...prev, ...patch, id, catalog });
    const next = [...relays];
    next[index] = merged;
    await writeRelays(next);
    reconcileRelays();
    return summaryOf(id);
  });
}

/** `catalog` 的部分更新：models 按键替换 / `null` 删除，其余字段给了才换。 */
function mergeCatalogPatch(
  prev: RelayConfig["catalog"],
  patch: { source?: "static" | "models-endpoint"; models?: Record<string, unknown>; unknownCredits?: number } | undefined,
): RelayConfig["catalog"] {
  if (patch === undefined) return prev;
  const models: Record<string, z.infer<typeof modelSpecSchema>> = { ...(prev?.models ?? {}) };
  for (const [key, value] of Object.entries(patch.models ?? {})) {
    if (value === null) delete models[key];
    else models[key] = value as z.infer<typeof modelSpecSchema>;
  }
  return {
    source: patch.source ?? prev?.source ?? "static",
    models,
    unknownCredits: patch.unknownCredits ?? prev?.unknownCredits,
  };
}

export async function deleteRelay(id: string): Promise<void> {
  return withRelayLock(async () => {
    const relays = fileRelays();
    const next = relays.filter((r) => r.id !== id);
    if (next.length === relays.length) {
      throw new ProviderHttpError(404, "not_found", `relay ${id} 不存在（env 预设不由接口管理）`);
    }
    await writeRelays(next);
    reconcileRelays();
  });
}

function summaryOf(id: string): RelaySummary {
  const found = listRelays().find((r) => r.id === id);
  if (!found) throw new ProviderHttpError(500, "internal", `relay ${id} 装配失败`);
  return found;
}

/** 测试与路由共用：当前 loadRelaysDetailed 的来源。 */
export function relaysSource(): string {
  return loadRelaysDetailed().source;
}
