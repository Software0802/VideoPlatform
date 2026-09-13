import { priceCny } from "@/lib/billing/prices";
import {
  imageProviderOrder,
  isMockMode,
  klingVideoAudio,
  lumenProductsRaw,
  videoProviderOrder,
} from "@/lib/env";
import { log } from "@/lib/log";
import { isExhausted } from "@/lib/providers/exhaustion";
import { envModelFor } from "@/lib/providers/model-name";
import { servesResolution } from "@/lib/providers/resolution";
import { currentProviderId, hasProviderKey } from "@/lib/providers/router";
import type {
  AspectRatio,
  ImageResolution,
  NativeMode,
  ProviderId,
  Resolution,
} from "@/lib/providers/types";

/**
 * 产品目录：**对用户露出的模型**（用户 2026-09-06 决定：只露产品名与售价，不露供应商名）。
 *
 * 一个「产品」= 一家 provider 的一个上游模型 + 一组我们愿意让用户选的档位。它是
 * `POST /api/jobs` 的 `model` 字段与 `GET /api/models` 的唯一事实源：请求里那一串是
 * **产品 id**（`video-standard`），不是上游模型名（`kling-2.6`）——把上游模型名交给
 * 浏览器等于让用户能点名一个我们没验证过的模型，也把供应商暴露了出去。
 *
 * 与 `providers/*.capabilities()` 的分工：capabilities 说的是「这家上游技术上能做什么」，
 * 产品说的是「我们卖什么」。路由（没指定产品时）仍按 ORDER + capabilities 走；指定了
 * 产品就直接落到它的 provider，两条路最后都会把选中的产品 id 写进记录。
 */
export type Product = {
  id: string;
  /** 用户看到的名字。中文、不含供应商名。 */
  name: string;
  kind: "video" | "image";
  provider: ProviderId;
  /**
   * 兜底的上游模型名；`models` 里没有该 mode 时用它。
   *
   * **可选**：省略 = 这个产品不钉死模型，用实例按 provider 配的那个
   * （`KLING_VIDEO_MODEL` / `OPENAI_IMAGE_MODEL` / `YMAN_IMAGE_MODEL` / grok 的 mode 矩阵）。
   * 默认目录里绝大多数产品都省略：把模型名抄进产品表，等于让运维改完环境变量还是发旧模型。
   * 只有「同一家的两个产品必须发不同模型」时才写（`models` 的按 mode 覆盖同理）。
   */
  model?: string;
  /** 同一个产品在不同 mode 下的上游模型（YMan 的文生 / 图文是两个模型）。 */
  models?: Partial<Record<NativeMode, string>>;
  modes: NativeMode[];
  /** 视频档位；图片产品留空数组，用 `imageResolutions`。 */
  resolutions: Resolution[];
  /** 用户没选分辨率时用哪一档。省略时取 `resolutions` 里最低的一档。 */
  defaultResolution?: Resolution;
  aspectRatios: AspectRatio[];
  /** 上游按档计费的时长枚举。**省略 = 连续**（grok 那样 1–15 秒都收）。 */
  durations?: number[];
  /**
   * `off` = 一定无声；`native` = 上游按我们的要求出声（可灵，且只在 1080p）；
   * `uncontrolled` = 上游没有音频开关，出不出声由模型决定——不可控就不能收有声的加价，
   * 记录里一律记无声（`provider-settings.ts` 同一口径）。
   */
  audio: "off" | "native" | "uncontrolled";
  /** 能不能发首尾帧。当前只有可灵为真，且上游强制 1080p。 */
  supportsLastFrame: boolean;
  /**
   * 能不能走 30 / 45 / 60 秒长片（一致性管线，`HARNESS_ENABLED` 时才露出芯片）。
   * 管线的续接依赖 xAI Files API，所以只有 grok 产品为真；UI 不再靠「时长连续」推断。
   */
  supportsLongForm: boolean;
  maxReferenceImages: number;
  /** 图片产品的档位；视频产品省略。 */
  imageResolutions?: ImageResolution[];
  description: string;
};

/**
 * 默认目录（2026-09-06）。改这里要同时想清楚三件事：这个模型的档位、它的售价档
 * （`billing/prices.ts` 与档位挂钩）、以及路由在没指定产品时会不会选中它。
 *
 * 供应商与上游模型名只出现在这张表里，不出现在任何返回给浏览器的字段里。
 */
export const DEFAULT_PRODUCTS: readonly Product[] = [
  {
    id: "video-fast",
    name: "快速",
    kind: "video",
    provider: "yman",
    // 文生用纯文生模型，图生 / 参考生用收参考图的那个（上游是两个模型，同一个产品）。
    // 三个 mode 各自钉死，所以不需要兜底的 `model`。
    models: {
      text_to_video: "minimax-h3",
      image_to_video: "minimax-h3-933-图文",
      reference_to_video: "minimax-h3-933-图文",
    },
    modes: ["text_to_video", "image_to_video", "reference_to_video"],
    resolutions: ["720p"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16"],
    durations: [5, 10, 15],
    audio: "uncontrolled",
    supportsLastFrame: false,
    supportsLongForm: false,
    maxReferenceImages: 9,
    description: "出片最快的一档，720p，最多九张参考图。",
  },
  {
    id: "video-standard",
    name: "标准",
    kind: "video",
    provider: "kling",
    // 模型名不写：可灵这条通道发哪个模型由 `KLING_VIDEO_MODEL` 定，产品只决定档位与音轨。
    modes: ["text_to_video", "image_to_video"],
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16", "1:1"],
    durations: [5, 10],
    audio: "off",
    // 首尾帧只有这条通道能发，且上游只在 1080p 接受（见 kling/rest-map.ts）。
    supportsLastFrame: true,
    supportsLongForm: false,
    maxReferenceImages: 0,
    description: "画面稳定的常规档，可选 720p / 1080p，支持首尾帧（首尾帧固定 1080p）。",
  },
  {
    id: "video-hd-audio",
    name: "高清有声",
    kind: "video",
    provider: "kling",
    // 同「标准」：模型走 `KLING_VIDEO_MODEL`，两个产品的差别只在分辨率与音轨。
    modes: ["text_to_video", "image_to_video"],
    resolutions: ["1080p"],
    defaultResolution: "1080p",
    aspectRatios: ["16:9", "9:16", "1:1"],
    durations: [5, 10],
    audio: "native",
    supportsLastFrame: true,
    supportsLongForm: false,
    maxReferenceImages: 0,
    description: "1080p 且自带音轨，单价最高。",
  },
  {
    id: "video-grok",
    name: "Grok",
    kind: "video",
    provider: "grok",
    // 生成三兄弟（t2v / i2v / r2v）走 grok 矩阵的默认模型；编辑与延长上游只认 1.0 那个，
    // 所以只把这两个 mode 钉死，其余照旧跟着 `mode-matrix` 的默认走。
    models: { edit_video: "grok-imagine-video", extend_video: "grok-imagine-video" },
    modes: ["text_to_video", "image_to_video", "reference_to_video", "edit_video", "extend_video"],
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    // durations 故意省略：这条通道的秒数是连续的 1–15，不是档位。
    audio: "native",
    supportsLastFrame: false,
    supportsLongForm: true,
    maxReferenceImages: 7,
    description: "画幅与时长最自由的一档，1–15 秒、七种画幅、自带音轨。",
  },
  {
    id: "image-fast",
    name: "图片 · 快速",
    kind: "image",
    provider: "yman",
    // 模型走 `YMAN_IMAGE_MODEL`（中转的生图模型换得勤，写死只会让运维改了没用）。
    modes: ["text_to_image"],
    resolutions: [],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    audio: "off",
    supportsLastFrame: false,
    supportsLongForm: false,
    maxReferenceImages: 0,
    imageResolutions: ["1k", "2k"],
    description: "出图最快的一档，1K / 2K、七种画幅。",
  },
  {
    id: "image-standard",
    name: "图片 · 标准",
    kind: "image",
    provider: "openai",
    // 模型走 `OPENAI_IMAGE_MODEL`。
    modes: ["text_to_image"],
    resolutions: [],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    audio: "off",
    supportsLastFrame: false,
    supportsLongForm: false,
    maxReferenceImages: 0,
    imageResolutions: ["1k", "2k"],
    description: "细节更稳的常规出图档，1K / 2K、七种画幅。",
  },
  {
    id: "image-grok",
    name: "图片 · Grok",
    kind: "image",
    provider: "grok",
    // 模型走 grok 的 mode 矩阵（`MODEL_IMAGE`）。
    modes: ["text_to_image"],
    resolutions: [],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    audio: "off",
    supportsLastFrame: false,
    // 长片是视频侧一致性管线的档位，图片产品永远为假——这里曾经写成 true，
    // 面板据它给图片页追加 30 / 45 / 60 的时长档，而那几个档在图片路径上根本不存在。
    supportsLongForm: false,
    maxReferenceImages: 0,
    imageResolutions: ["1k", "2k"],
    description: "风格更强烈的出图档，1K / 2K、七种画幅。",
  },
];

type CatalogCache = { raw: string | undefined; list: Product[]; byId: Map<string, Product> };

let cache: CatalogCache | null = null;

/** 默认表叠加 `LUMEN_PRODUCTS`（按 id 覆盖，新 id 追加）。坏 JSON 记一条 warn 后回落默认表。 */
export function allProducts(): Product[] {
  return catalog().list;
}

export function productById(id: string | undefined | null): Product | undefined {
  if (!id) return undefined;
  return catalog().byId.get(String(id).trim());
}

/**
 * 这一刻用户真能下单的产品：provider 写在这条通道（视频 / 图片分开）的 ORDER 里、
 * 配了 key、且没被判定积分耗尽。露出一个提交就会 400 / 503 的产品，比不露出更糟。
 *
 * 两个例外：
 * - mock 实例（没有任何真 key，或 `LUMEN_FORCE_MOCK`）返回**全部**产品——那台实例本来就
 *   拿 mock 回答一切，界面上留个空目录只会让开发与 e2e 无从选起。
 * - 可灵的有声产品要求 `KLING_VIDEO_AUDIO=native`：提交时的音轨判定读的是同一个变量，
 *   实例没开就选它，等于卖一个一定不出声的「有声」档。
 */
export function availableProducts(): Product[] {
  if (isMockMode()) return allProducts();
  return allProducts().filter(isProductAvailable);
}

export function isProductAvailable(product: Product): boolean {
  if (isMockMode()) return true;
  // ORDER 是这台实例「愿意用谁」的唯一开关（AGENTS.md「路由按能力 + 优先级，不按 key
  // 存在性」）：只配了 `KLING_API_KEY` 却没把 kling 写进 `VIDEO_PROVIDER_ORDER` 的实例，
  // 路由永远不会选中可灵，目录也就不能把可灵的产品摆出来——那是一个点了必被拒的选项。
  if (!inProviderOrder(product)) return false;
  if (!hasProviderKey(product.provider)) return false;
  if (isExhausted(product.provider, product.kind)) return false;
  if (product.provider === "kling" && product.audio === "native" && klingVideoAudio() !== "native") {
    return false;
  }
  return true;
}

/** 这个产品的 provider 在对应通道（视频 / 图片各一份）的 ORDER 里。 */
function inProviderOrder(product: Product): boolean {
  const order: readonly string[] =
    product.kind === "image" ? imageProviderOrder() : videoProviderOrder();
  return order.includes(product.provider);
}

/**
 * 这个产品在这个 mode 下要发给上游的模型名。
 *
 * 优先级：按 mode 的覆盖 → 产品自己的兜底 → 实例按 provider 配的那个（读环境变量）。
 * 最后这一档是产品**不写** `model` 时的正常形态，不是异常兜底。
 */
export function modelForProduct(product: Product, mode: NativeMode): string {
  return product.models?.[mode] ?? product.model ?? envModelFor(product.provider, mode);
}

/** 用户没选分辨率时这个产品用哪一档。 */
export function defaultResolutionOf(product: Product): Resolution | undefined {
  if (product.defaultResolution) return product.defaultResolution;
  return [...product.resolutions].sort()[0];
}

/**
 * 已经选定 provider 后，这次任务该挂哪个产品名。
 *
 * `model` 是已经解析好的上游模型名：同一家有多个产品时（可灵的标准 / 高清有声）优先取
 * 模型对得上的那个，对不上再取第一个支持该 mode 的。mock 实例上没有任何产品声明
 * provider = mock，此时退回「第一个支持该 mode 的产品」当标签——那台实例的 provider
 * 本来就是个替身。
 *
 * `opts.audio` 是给「换家之后重新贴标签」用的（`jobs/runner.ts`）：可灵的两个产品共用
 * 同一个上游模型，只有音轨不同，光看模型名永远选中排在前面的「标准」——一条真的会
 * 出声、也按有声计过价的任务会被标成无声的那一档。
 */
export function productForProvider(
  provider: ProviderId,
  mode: NativeMode,
  model?: string,
  opts?: { audio?: "off" | "native" },
): Product | undefined {
  const usable = availableProducts().filter((p) => p.modes.includes(mode));
  const own = usable.filter((p) => p.provider === provider);
  if (own.length) {
    // 音轨对不上一个都不剩时退回全部：标签宁可粗一点，也不要没有。
    const byAudio = opts?.audio
      ? own.filter((p) => (p.audio === "native") === (opts.audio === "native"))
      : own;
    const pool = byAudio.length ? byAudio : own;
    const exact = model ? pool.find((p) => modelForProduct(p, mode) === model) : undefined;
    return exact ?? pool[0];
  }
  if (isMockMode()) return usable[0];
  return undefined;
}

/**
 * 没指定产品时，按现有的 ORDER 能力路由选出 provider，再取它的第一个匹配产品。
 * 路由抛错（画幅 / 分辨率没人接、全家耗尽）时返回 undefined——真正的拒绝由调用方
 * 那一次 `currentProviderId` 给出，这里不重复抛。
 */
export function defaultProductFor(
  mode: NativeMode,
  aspectRatio?: AspectRatio,
  hint?: { resolution?: Resolution; model?: string },
): Product | undefined {
  let provider: ProviderId;
  try {
    provider = currentProviderId(mode, { aspectRatio, resolution: hint?.resolution });
  } catch {
    return undefined;
  }
  return productForProvider(provider, mode, hint?.model);
}

/**
 * 目录页要显示的「一次大概多少钱」：视频按 5 秒 + 产品默认分辨率 + 它的音轨档算，
 * 图片按 1K 算。真实售价仍在提交时按归一后的参数重算（`create.ts`），这里只是标价牌。
 */
export function samplePriceCny(product: Product): number {
  if (product.kind === "image") {
    return priceCny({ mode: "text_to_image", imageResolution: "1k" });
  }
  return priceCny({
    mode: product.modes[0] ?? "text_to_video",
    durationSec: product.durations?.[0] ?? 5,
    resolution: defaultResolutionOf(product) ?? null,
    generateAudio: product.audio === "native",
  });
}

/** 这个产品接不接得下这个分辨率（向上归一后算接得下）。 */
export function productServesResolution(product: Product, resolution?: Resolution): boolean {
  if (product.kind === "image" || !product.resolutions.length) return true;
  return servesResolution(resolution, product.resolutions);
}

function catalog(): CatalogCache {
  const raw = lumenProductsRaw();
  if (cache && cache.raw === raw) return cache;
  const list = raw ? merge(DEFAULT_PRODUCTS, parseOverrides(raw)) : [...DEFAULT_PRODUCTS];
  cache = { raw, list, byId: new Map(list.map((p) => [p.id, p])) };
  return cache;
}

function merge(base: readonly Product[], overrides: Product[]): Product[] {
  const out = base.map((p) => ({ ...p }));
  for (const over of overrides) {
    const index = out.findIndex((p) => p.id === over.id);
    if (index >= 0) out[index] = over;
    else out.push(over);
  }
  return out;
}

/**
 * `LUMEN_PRODUCTS` 是一个**数组**：每一项要么覆盖同 id 的默认产品（逐字段合并，只想改
 * 默认分辨率的人不必把能力抄一遍），要么是一个全新的产品（那就必须自带 provider 与
 * modes，缺了就跳过——没有 provider 的产品连交给谁都不知道）。`model` 不是必填：省略
 * 就是「用实例给这家配的那个模型」（`modelForProduct` 的最后一档）。
 */
function parseOverrides(raw: string): Product[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("warn", "LUMEN_PRODUCTS 无法解析，产品目录回落内置表", { length: raw.length });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log("warn", "LUMEN_PRODUCTS 不是数组，产品目录回落内置表", { length: raw.length });
    return [];
  }
  const out: Product[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const base = DEFAULT_PRODUCTS.find((p) => p.id === id);
    const product = parseProduct(id, entry, base);
    if (product) out.push(product);
    else log("warn", "LUMEN_PRODUCTS 里的产品缺少必填字段，已跳过", { id });
  }
  return out;
}

function parseProduct(id: string, value: Record<string, unknown>, base?: Product): Product | null {
  const provider = (typeof value.provider === "string" ? value.provider.trim() : "") as ProviderId;
  const merged: Product = {
    id,
    name: str(value.name) ?? base?.name ?? id,
    kind: value.kind === "image" || value.kind === "video" ? value.kind : (base?.kind ?? "video"),
    provider: provider || (base?.provider as ProviderId),
    model: str(value.model) ?? base?.model,
    models: (isRecord(value.models)
      ? (Object.fromEntries(
          Object.entries(value.models).filter(([, v]) => typeof v === "string" && v.trim()),
        ) as Product["models"])
      : undefined) ?? base?.models,
    modes: (strArray(value.modes) as NativeMode[] | undefined) ?? base?.modes ?? [],
    resolutions: (strArray(value.resolutions) as Resolution[] | undefined) ?? base?.resolutions ?? [],
    defaultResolution:
      (str(value.defaultResolution) as Resolution | undefined) ?? base?.defaultResolution,
    aspectRatios: (strArray(value.aspectRatios) as AspectRatio[] | undefined) ?? base?.aspectRatios ?? [],
    durations: numArray(value.durations) ?? base?.durations,
    audio:
      value.audio === "off" || value.audio === "native" || value.audio === "uncontrolled"
        ? value.audio
        : (base?.audio ?? "off"),
    supportsLastFrame:
      typeof value.supportsLastFrame === "boolean"
        ? value.supportsLastFrame
        : (base?.supportsLastFrame ?? false),
    supportsLongForm:
      typeof value.supportsLongForm === "boolean"
        ? value.supportsLongForm
        : (base?.supportsLongForm ?? false),
    maxReferenceImages:
      typeof value.maxReferenceImages === "number" && Number.isFinite(value.maxReferenceImages)
        ? Math.max(0, Math.floor(value.maxReferenceImages))
        : (base?.maxReferenceImages ?? 0),
    imageResolutions:
      (strArray(value.imageResolutions) as ImageResolution[] | undefined) ?? base?.imageResolutions,
    description: str(value.description) ?? base?.description ?? "",
  };
  if (!merged.provider || !merged.modes.length) return null;
  return merged;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((s): s is string => typeof s === "string" && Boolean(s.trim()));
  return out.length ? out : undefined;
}

function numArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
