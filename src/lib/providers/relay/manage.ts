import {
  loadRelaysDetailed,
  readRelaysFile,
  relaysFileExists,
  relayConfigSchema,
  writeRelays,
  type RelayConfig,
} from "@/lib/providers/relay/config";
import { reconcileRelays, currentRelayViews } from "@/lib/providers/relay/assemble";
import { healthList } from "@/lib/providers/health";
import { relayCatalogSnapshotFetchedAt } from "@/lib/providers/relay/discover";
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
};

export function listRelays(): RelaySummary[] {
  const fileIds = new Set(
    relaysFileExists() ? readRelaysFile().map((r) => r.id) : [],
  );
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
  const relays = fileRelays();
  if (relays.some((r) => r.id === cfg.id)) {
    throw new ProviderHttpError(409, "relay_exists", `relay ${cfg.id} 已存在`);
  }
  await writeRelays([...relays, cfg]);
  reconcileRelays();
  return summaryOf(cfg.id);
}

const patchSchema = relayConfigSchema.partial().omit({ id: true });

export async function updateRelay(id: string, body: unknown): Promise<RelaySummary> {
  const relays = fileRelays();
  const index = relays.findIndex((r) => r.id === id);
  if (index < 0) {
    throw new ProviderHttpError(404, "not_found", `relay ${id} 不存在（env 预设不由接口管理）`);
  }
  const patch = patchSchema.parse(body);
  const merged = relayConfigSchema.parse({ ...relays[index], ...patch, id });
  const next = [...relays];
  next[index] = merged;
  await writeRelays(next);
  reconcileRelays();
  return summaryOf(id);
}

export async function deleteRelay(id: string): Promise<void> {
  const relays = fileRelays();
  const next = relays.filter((r) => r.id !== id);
  if (next.length === relays.length) {
    throw new ProviderHttpError(404, "not_found", `relay ${id} 不存在（env 预设不由接口管理）`);
  }
  await writeRelays(next);
  reconcileRelays();
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
