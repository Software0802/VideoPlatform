import { ymanI2vModel, ymanModelCatalogRaw, ymanT2vModel, ymanUnknownCredits } from "@/lib/env";
import { log } from "@/lib/log";
import { makeRelayCatalog, type RelayModelSpec } from "@/lib/providers/relay/catalog";
import type { AspectRatio, NativeMode, Resolution } from "@/lib/providers/types";

export type YmanResolution = Extract<Resolution, "720p" | "1080p">;
export type YmanModelSpec = RelayModelSpec;

const RATIOS_LANDSCAPE_PORTRAIT: AspectRatio[] = ["16:9", "9:16"];

/**
 * 上游 https://vip.yman.cc/docs 的静态能力与价目（2026-09-06 实读）。
 *
 * **键是 `GET /v1/models` 返回的展示名**，文档明确要求 `model` 用这一串，不要用后台内部
 * 模型名；内部名（`minimax_h3_t2v` 之类）降级成 `aliases`，只用来认出用户填的旧名字。
 * 2026-09-06 实测 `/v1/models` 还返回 `seedance2.0-900-3`、`Seedance2.0-933-条`、
 * `seedance2.0-fast满血`、`sd-2.0-fast-真人`、`seedance2.5-9图` 五个 id，文档没给它们的
 * 档位与价目，所以这里不登记（照样能填进 `YMAN_*_MODEL` 直接发，只是按
 * `YMAN_UNKNOWN_CREDITS` 估价）——宁可承认不知道，也不编一张价目表。
 *
 * 价目单位是**积分**，¥1 = 100 积分；一次调用 = 分辨率价 + 时长价，创建任务时预扣，
 * 失败自动退。这里只登记 720p 一档——上游这几个视频模型当前都只出 720p（图文那档
 * 文档写 768p，短边仍 <1080，按同一档记）。表随时会过期，改代码之外还留了
 * `YMAN_MODEL_CATALOG` 这条覆盖 / 追加的口子。
 */
export const YMAN_MODELS: Record<string, YmanModelSpec> = {
  // 价目 2026-09-13 沿用旧档（`minimax-H3 文字`），未经账单核实。
  "minimax-h3": {
    aliases: ["minimax-H3 文字", "minimax_h3_t2v"],
    durations: [5, 10, 15],
    resolutions: ["720p"],
    ratios: RATIOS_LANDSCAPE_PORTRAIT,
    // 纯文生：上游不收参考图，发上去会 400。
    maxReferenceImages: 0,
    credits: { resolution: { "720p": 10 }, duration: { "5": 40, "10": 90, "15": 140 } },
  },
  "minimax-h3-933-图文": {
    aliases: ["minimax_h3_ref2v"],
    durations: [5, 10, 15],
    resolutions: ["720p"],
    ratios: RATIOS_LANDSCAPE_PORTRAIT,
    maxReferenceImages: 9,
    credits: { resolution: { "720p": 10 }, duration: { "5": 40, "10": 90, "15": 140 } },
  },
  "grok-video-1.5": {
    aliases: ["grok-imagine-video-1.5-preview"],
    durations: [5, 10, 15],
    resolutions: ["720p"],
    ratios: RATIOS_LANDSCAPE_PORTRAIT,
    maxReferenceImages: 9,
    credits: { resolution: { "720p": 10 }, duration: { "5": 70, "10": 90, "15": 90 } },
  },
  "seedance2.0-900-720p": {
    aliases: ["seedance2.0-svip-900-720p"],
    durations: [10, 15],
    resolutions: ["720p"],
    ratios: RATIOS_LANDSCAPE_PORTRAIT,
    maxReferenceImages: 9,
    credits: { resolution: { "720p": 100 }, duration: { "10": 50, "15": 50 } },
  },
  "SD2.0 满血": {
    aliases: ["seedance2.0"],
    durations: [10, 15],
    resolutions: ["720p"],
    // 目录里唯一出方图的一档。
    ratios: ["16:9", "9:16", "1:1"],
    maxReferenceImages: 9,
    credits: { resolution: { "720p": 100 }, duration: { "10": 350, "15": 350 } },
  },
  "sd-2.5-30秒": {
    aliases: ["sd2.5"],
    durations: [30],
    resolutions: ["720p"],
    ratios: RATIOS_LANDSCAPE_PORTRAIT,
    maxReferenceImages: 9,
    credits: { resolution: { "720p": 10 }, duration: { "30": 190 } },
  },
};

/**
 * 认不出的模型（用户自己在 `YMAN_T2V_MODEL` 里填了个新名字）的兜底能力。
 * 取上游最常见的形状，`credits` 留空 → `creditsFor` 落到 `YMAN_UNKNOWN_CREDITS`。
 */
const UNKNOWN_MODEL: YmanModelSpec = {
  aliases: [],
  durations: [5, 10, 15],
  resolutions: ["720p"],
  ratios: RATIOS_LANDSCAPE_PORTRAIT,
  maxReferenceImages: 9,
  credits: { resolution: {}, duration: {} },
};

type CatalogCache = {
  raw: string | undefined;
  table: Record<string, YmanModelSpec>;
};

let catalogCache: CatalogCache | null = null;

/** 静态表 + `YMAN_MODEL_CATALOG` 覆盖 / 追加的结果。坏 JSON 记一条 warn 后回落静态表。 */
function mergedTable(): Record<string, YmanModelSpec> {
  const raw = ymanModelCatalogRaw();
  if (catalogCache && catalogCache.raw === raw) return catalogCache.table;
  const table = raw ? { ...YMAN_MODELS, ...parseCatalog(raw) } : { ...YMAN_MODELS };
  catalogCache = { raw, table };
  return table;
}

export function ymanCatalog(): Record<string, YmanModelSpec> {
  return mergedTable();
}

function parseCatalog(raw: string): Record<string, YmanModelSpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("warn", "YMAN_MODEL_CATALOG 无法解析，回落到内置模型表", { length: raw.length });
    return {};
  }
  if (!isRecord(parsed)) {
    log("warn", "YMAN_MODEL_CATALOG 不是对象，回落到内置模型表", { length: raw.length });
    return {};
  }
  const out: Record<string, YmanModelSpec> = {};
  for (const [model, spec] of Object.entries(parsed)) {
    // 覆盖也能用别名寻址：内部名写惯了的人不必先去查展示名。
    const display = builtinDisplayName(model.trim());
    const parsedSpec = parseSpec(spec, YMAN_MODELS[display]);
    if (parsedSpec) out[display] = parsedSpec;
  }
  return out;
}

/** 只查内置表的别名（`parseCatalog` 期间别名索引还没建好，不能走 `resolveModel`）。 */
function builtinDisplayName(name: string): string {
  if (YMAN_MODELS[name]) return name;
  for (const [display, spec] of Object.entries(YMAN_MODELS)) {
    if (spec.aliases.includes(name)) return display;
  }
  return name;
}

/**
 * 单个模型的覆盖。逐字段合并到基线（内置表里的同名模型，没有就是 `UNKNOWN_MODEL`）——
 * 只想改个价目的人不该被迫把 durations / ratios 全抄一遍。
 */
function parseSpec(value: unknown, base: YmanModelSpec | undefined): YmanModelSpec | null {
  if (!isRecord(value)) return null;
  const fallback = base ?? UNKNOWN_MODEL;
  const durations = numberArray(value.durations)?.filter((n) => n > 0);
  const resolutions = stringArray(value.resolutions)?.filter(
    (s): s is YmanResolution => s === "720p" || s === "1080p",
  );
  const ratios = stringArray(value.ratios) as AspectRatio[] | undefined;
  const maxReferenceImages =
    typeof value.maxReferenceImages === "number" && Number.isFinite(value.maxReferenceImages)
      ? Math.max(0, Math.floor(value.maxReferenceImages))
      : fallback.maxReferenceImages;
  const credits = isRecord(value.credits) ? value.credits : undefined;
  const aliases = stringArray(value.aliases)?.map((s) => s.trim()).filter(Boolean);
  return {
    aliases: aliases?.length ? [...new Set(aliases)] : fallback.aliases,
    durations: durations?.length ? [...new Set(durations)].sort((a, b) => a - b) : fallback.durations,
    resolutions: resolutions?.length ? resolutions : fallback.resolutions,
    ratios: ratios?.length ? ratios : fallback.ratios,
    maxReferenceImages,
    credits: {
      resolution: (numberMap(credits?.resolution) as YmanModelSpec["credits"]["resolution"]) ??
        fallback.credits.resolution,
      duration: numberMap(credits?.duration) ?? fallback.credits.duration,
    },
  };
}

/**
 * 目录引擎（`providers/relay/catalog.ts`）：别名解析、档位归一、积分计价与 YMan 共享
 * 同一份逻辑；表、unknownCredits 与默认模型名仍按 env 在调用时取。
 */
export const ymanRelayCatalog = makeRelayCatalog({
  table: mergedTable,
  unknownCredits: ymanUnknownCredits,
  configuredModel: (mode: NativeMode) =>
    mode === "text_to_video" ? ymanT2vModel() : ymanI2vModel(),
});

/**
 * 用户填的名字 → 目录里的**展示名**（`/v1/models` 的 id，也就是发给上游的那一串）。
 * 展示名与别名都能命中；认不出就原样返回（去空白）——上游随时会上新模型，
 * 认不出不等于不能用，只是我们估不准价。
 */
export const resolveModel = ymanRelayCatalog.resolveModel;

/** 这个模型的能力；认不出就给通用兜底，绝不抛——路由已经选中 yman 了，此时抛只会打挂任务。 */
export const ymanCapabilities = ymanRelayCatalog.specFor;

/** 上游是否登记过这个模型（`estimateCostUsd` 用它判断该不该走积分口径）。别名也算认得。 */
export const isYmanModel = ymanRelayCatalog.isKnownModel;

/**
 * 一个 mode 该用哪个上游模型，**已归一成展示名**。t2v 用纯文生模型；i2v / r2v 用收参考图
 * 的那个（上游把首帧与参考图归到同一个 `reference_images` 字段，所以两者同一个模型）。
 *
 * 归一在这里做而不是在 rest-map：`create.ts` 把它写进 `job.model`，详情卡、账目、日志
 * 看到的就都是「真正发给上游的那一串」，而不是用户随手填的内部名。
 */
export const modelFor = ymanRelayCatalog.modelFor;

/**
 * 这一刻 yman 视频侧能出的画幅（t2v 与 i2v 两个模型的**并集**）。
 *
 * 并集而不是交集：路由按画幅挑 provider，交集会把 `SD2.0 满血` 才有的 1:1 白白让出去。
 * 代价是「t2v 出得了、i2v 出不了」的画幅仍可能落到 yman，此时 rest-map 会 400
 * 兜底——两个模型混搭才有的边角，比静默改写用户选的画幅可接受。
 */
export const ymanVideoRatios = ymanRelayCatalog.videoRatios;

/**
 * 这一刻 yman 视频侧出得了的分辨率档（t2v 与 i2v 两个模型的**并集**，理由同
 * `ymanVideoRatios`）。路由拿它筛选：请求 1080p 时不会被派给只有 720p 的模型。
 */
export const ymanVideoResolutions = ymanRelayCatalog.videoResolutions;

/**
 * 参考生视频的上限，取 i2v / r2v 那个模型的（首帧与参考图在上游是同一个
 * `reference_images` 字段）。纯文生模型是 0，不参与这条。
 */
export const ymanMaxReferenceImages = ymanRelayCatalog.maxReferenceImages;

/**
 * 请求秒数 → 上游认的时长档，**向上**取。4→5、6/8→10、12→15，超出最大档取最大档。
 * 向上而不是就近：上游按档计费，取到更短的一档等于用户少拿了片子还照付这一档的钱。
 * 归一后的值必须写回 job（`create.ts`），账目与详情卡才是「会被计费的那个时长」。
 */
export const normalizeYmanDuration = ymanRelayCatalog.normalizeDuration;

/** 这次调用要预扣多少积分。认不出的模型 / 缺档时落到 `YMAN_UNKNOWN_CREDITS`，绝不返回 0。 */
export const creditsFor = ymanRelayCatalog.creditsFor;

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((s): s is string => typeof s === "string" && Boolean(s.trim()));
}

function numberMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
