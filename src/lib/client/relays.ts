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
export type RelayModelKind = "video" | "image" | "chat";

/** 产品级售价覆盖的镜像（`ProductPriceOverride` 的白名单读取结果）。 */
export type RelayModelPrice = {
  video?: { "5"?: number; "10"?: number; hd?: number; audio?: number };
  image?: { "1k"?: number; "2k"?: number };
};

/** `GET /api/admin/relays` 的 `catalog.models[]` 镜像。 */
export type RelayCatalogModel = {
  id: string;
  kind?: RelayModelKind;
  upstreamName?: string;
  name?: string;
  displayName: string;
  hidden?: boolean;
  price?: RelayModelPrice;
  durations: number[];
  resolutions: string[];
  ratios: string[];
  maxReferenceImages: number;
  credits?: {
    resolution: Record<string, number>;
    duration: Record<string, number>;
    flat?: number;
  };
  fromSnapshot: boolean;
  fromConfig: boolean;
  defaultPinned: boolean;
  listed: boolean;
};

export type RelayCatalog = {
  source: RelayCatalogSource;
  snapshotAt?: string;
  videoDefaults: Partial<Record<"text_to_video" | "image_to_video" | "reference_to_video", string>>;
  imageModel?: string;
  models: RelayCatalogModel[];
};

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
  catalog?: RelayCatalog;
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

/** PATCH 的 catalog.models 是按模型的部分更新：给到的键替换、传 `null` 删除该模型的覆盖。 */
export type RelayModelPatch = {
  kind?: RelayModelKind;
  name?: string;
  hidden?: boolean;
  price?: RelayModelPrice;
  durations?: number[];
  resolutions?: ("720p" | "1080p")[];
  ratios?: string[];
  maxReferenceImages?: number;
};

export type RelayPatchInput = Partial<Omit<RelayCreateInput, "id" | "catalog">> & {
  catalog?: {
    source?: RelayCatalogSource;
    models?: Record<string, RelayModelPatch | null>;
    unknownCredits?: number;
  };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown): boolean => v === true;

function readHealth(raw: unknown): RelayHealthState | undefined {
  return raw === "ok" || raw === "cooldown" || raw === "half-open" ? raw : undefined;
}

function strOrUndef(v: unknown): string | undefined {
  const s = str(v).trim();
  return s || undefined;
}

function numMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function readPrice(raw: unknown): RelayModelPrice | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const video = numMap(src.video);
  const image = numMap(src.image);
  const out: RelayModelPrice = {};
  if (Object.keys(video).length) {
    out.video = {};
    for (const k of ["5", "10", "hd", "audio"] as const) if (k in video) out.video[k] = video[k];
  }
  if (Object.keys(image).length) {
    out.image = {};
    for (const k of ["1k", "2k"] as const) if (k in image) out.image[k] = image[k];
  }
  return out.video || out.image ? out : undefined;
}

function readCatalogModel(raw: unknown): RelayCatalogModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id);
  if (!id) return null;
  const credits =
    m.credits && typeof m.credits === "object" && !Array.isArray(m.credits)
      ? {
          resolution: numMap((m.credits as Record<string, unknown>).resolution),
          duration: numMap((m.credits as Record<string, unknown>).duration),
          flat:
            typeof (m.credits as Record<string, unknown>).flat === "number"
              ? ((m.credits as Record<string, unknown>).flat as number)
              : undefined,
        }
      : undefined;
  return {
    id,
    kind: m.kind === "video" || m.kind === "image" || m.kind === "chat" ? m.kind : undefined,
    upstreamName: strOrUndef(m.upstreamName),
    name: strOrUndef(m.name),
    displayName: str(m.displayName) || id,
    hidden: bool(m.hidden),
    price: readPrice(m.price),
    durations: Array.isArray(m.durations)
      ? m.durations.filter((d): d is number => typeof d === "number" && Number.isFinite(d))
      : [],
    resolutions: Array.isArray(m.resolutions)
      ? m.resolutions.filter((r): r is string => typeof r === "string")
      : [],
    ratios: Array.isArray(m.ratios) ? m.ratios.filter((r): r is string => typeof r === "string") : [],
    maxReferenceImages: Math.max(0, Math.trunc(num(m.maxReferenceImages))),
    credits,
    fromSnapshot: bool(m.fromSnapshot),
    fromConfig: bool(m.fromConfig),
    defaultPinned: bool(m.defaultPinned),
    listed: bool(m.listed),
  };
}

function readCatalog(raw: unknown): RelayCatalog | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const models = Array.isArray(c.models)
    ? c.models.map(readCatalogModel).filter((m): m is RelayCatalogModel => m !== null)
    : [];
  const defaults =
    c.videoDefaults && typeof c.videoDefaults === "object" && !Array.isArray(c.videoDefaults)
      ? (c.videoDefaults as Record<string, unknown>)
      : {};
  return {
    source: c.source === "models-endpoint" ? "models-endpoint" : "static",
    snapshotAt: strOrUndef(c.snapshotAt),
    videoDefaults: {
      text_to_video: strOrUndef(defaults.text_to_video),
      image_to_video: strOrUndef(defaults.image_to_video),
      reference_to_video: strOrUndef(defaults.reference_to_video),
    },
    imageModel: strOrUndef(c.imageModel),
    models,
  };
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
    catalog: readCatalog(r.catalog),
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
