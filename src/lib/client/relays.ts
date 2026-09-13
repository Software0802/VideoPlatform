import { parseAuthed } from "@/lib/client/http";

/**
 * `/api/admin/relays*` 的浏览器侧读取口（N3.5 中转管理页）。
 *
 * `RelaySummary` 是 `src/lib/providers/relay/manage.ts` 同名类型的镜像——服务端
 * 已经只下发 `keyEnv` 变量名与 `hasKey` 布尔，key 值永远不出网；这里仍按白名单
 * 逐字段读取，与 `models.ts` 的 `readProduct` 同一口径：只信检查过的值。
 */

export type RelaySource = "file" | "env-seed" | "legacy";
export type RelayHealthState = "ok" | "cooldown" | "half-open";
export type RelayCatalogSource = "static" | "models-endpoint";

export type RelayEntry = {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string;
  hasKey: boolean;
  enabled: boolean;
  priority: number;
  registered: boolean;
  source: RelaySource;
  channels: { video: boolean; image: boolean; chat: boolean };
  catalogSource: RelayCatalogSource | null;
  catalogSnapshotAt: string | undefined;
  health: { video?: RelayHealthState; image?: RelayHealthState };
  /** false = env 预设（PATCH / DELETE 不适用，页面上显示为只读）。 */
  managed: boolean;
};

/** `POST /api/admin/relays/:id/discover` 的响应形状（`DiscoverResult` 的镜像）。 */
export type RelayDiscoverResult = {
  fetchedAt: string;
  models: string[];
  diff: { added: string[]; removed: string[] };
};

/** `POST /api/admin/relays/:id/probe` 的响应形状。`billed` 恒为 false（直探测，不走账务）。 */
export type RelayProbeResult = {
  ok: boolean;
  kind: "image" | "chat";
  status: number;
  ms: number;
  billed: boolean;
  detail: string;
};

/** 新建表单的输入形状：与 `relayConfigSchema` 一一对应，可选块缺省即不发。 */
export type RelayCreateInput = {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string;
  enabled?: boolean;
  priority?: number;
  video?: { protocol: "openai-videos"; defaults?: Record<string, string> };
  image?: {
    protocol: "openai-images";
    model: string;
    quality?: "low" | "medium" | "high" | "auto";
    flexibleSizes?: boolean;
    editsEnabled?: boolean;
  };
  chat?: { model: string };
  catalog?: { source: RelayCatalogSource; models?: Record<string, unknown> };
};

export type RelayPatchInput = Partial<Omit<RelayCreateInput, "id">>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown): boolean => v === true;

function readHealth(raw: unknown): RelayHealthState | undefined {
  return raw === "ok" || raw === "cooldown" || raw === "half-open" ? raw : undefined;
}

function readRelay(raw: unknown): RelayEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const source: RelaySource =
    r.source === "file" || r.source === "env-seed" || r.source === "legacy" ? r.source : "legacy";
  const ch = (r.channels ?? {}) as Record<string, unknown>;
  const health = (r.health ?? {}) as Record<string, unknown>;
  return {
    id,
    name: str(r.name),
    baseUrl: str(r.baseUrl),
    keyEnv: str(r.keyEnv),
    hasKey: bool(r.hasKey),
    enabled: bool(r.enabled),
    priority: num(r.priority),
    registered: bool(r.registered),
    source,
    channels: { video: bool(ch.video), image: bool(ch.image), chat: bool(ch.chat) },
    catalogSource:
      r.catalogSource === "static" || r.catalogSource === "models-endpoint"
        ? r.catalogSource
        : null,
    catalogSnapshotAt: str(r.catalogSnapshotAt) || undefined,
    health: { video: readHealth(health.video), image: readHealth(health.image) },
    managed: bool(r.managed),
  };
}

export async function listRelays(): Promise<RelayEntry[]> {
  const res = await fetch("/api/admin/relays", { cache: "no-store" });
  const data = await parseAuthed<{ relays?: unknown }>(res, "无法读取中转列表");
  const raw = Array.isArray(data.relays) ? data.relays : [];
  return raw.map(readRelay).filter((r): r is RelayEntry => r !== null);
}

export async function createRelay(input: RelayCreateInput): Promise<RelayEntry> {
  const res = await fetch("/api/admin/relays", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await parseAuthed<{ relay?: unknown }>(res, "创建中转失败");
  const relay = readRelay(data.relay);
  if (!relay) throw new Error("创建中转失败");
  return relay;
}

export async function updateRelay(id: string, patch: RelayPatchInput): Promise<RelayEntry> {
  const res = await fetch(`/api/admin/relays/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await parseAuthed<{ relay?: unknown }>(res, "更新中转失败");
  const relay = readRelay(data.relay);
  if (!relay) throw new Error("更新中转失败");
  return relay;
}

export async function removeRelay(id: string): Promise<void> {
  const res = await fetch(`/api/admin/relays/${encodeURIComponent(id)}`, { method: "DELETE" });
  await parseAuthed<unknown>(res, "删除中转失败");
}

export async function discoverRelay(id: string): Promise<RelayDiscoverResult> {
  const res = await fetch(`/api/admin/relays/${encodeURIComponent(id)}/discover`, {
    method: "POST",
  });
  const data = await parseAuthed<RelayDiscoverResult>(res, "目录发现失败");
  return {
    fetchedAt: str(data.fetchedAt),
    models: Array.isArray(data.models) ? data.models.filter((m) => typeof m === "string") : [],
    diff: {
      added: Array.isArray(data.diff?.added) ? data.diff.added.filter((m) => typeof m === "string") : [],
      removed: Array.isArray(data.diff?.removed)
        ? data.diff.removed.filter((m) => typeof m === "string")
        : [],
    },
  };
}

export async function probeRelay(id: string): Promise<RelayProbeResult> {
  const res = await fetch(`/api/admin/relays/${encodeURIComponent(id)}/probe`, { method: "POST" });
  const data = await parseAuthed<RelayProbeResult>(res, "探测失败");
  return {
    ok: data.ok === true,
    kind: data.kind === "chat" ? "chat" : "image",
    status: num(data.status),
    ms: num(data.ms),
    billed: false,
    detail: str(data.detail),
  };
}
