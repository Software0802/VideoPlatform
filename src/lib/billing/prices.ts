import { priceTableRaw } from "@/lib/env";
import { log } from "@/lib/log";
import { isHarnessDuration } from "@/lib/providers/grok/mode-matrix";
import type { ImageResolution, NativeMode, Resolution } from "@/lib/providers/types";

/**
 * 对用户的**售价**表（方案 §3.2）。
 *
 * 与 `@/lib/cost` 的区别是「谁付钱给谁」：`cost.ts` 估的是我们付给上游的成本
 * （USD，随 provider / 模型 / 档位变化，成片后还会被真实账单覆盖）；这里是用户
 * 付给我们的价，人民币、定值、与 provider 无关——换掉可灵或 xAI 不该让用户看到的
 * 价格跟着抖。两套数字都留着：`costUsdActual` 供管理员分账，`priceCny` 才是余额扣款。
 *
 * 本文件必须能被客户端组件直接 import（提交面板要在本地算「本次约 ¥x」），所以
 * 只依赖同样进得了浏览器包的 `env` / `log` / `mode-matrix`，不碰 `node:*` 与文件系统。
 */

export const CURRENCY = "CNY";

/** 计价需要的请求形状。字段都取**归一之后**的值（可灵 5 / 10 秒、实际分辨率与音频档）。 */
export type PriceInput = {
  mode: NativeMode;
  durationSec?: number;
  resolution?: Resolution | null;
  generateAudio?: boolean;
  imageResolution?: ImageResolution | null;
};

/**
 * UI 也要拿到的静态表：`video["5"] / video["10"]` 是两档基价，`hd` 是 1080p 的倍率，
 * `audio` 是出声的加价（元，不是倍率）。`extend` / `edit` 与视频档无关，是各自的定值。
 */
export type PriceTable = {
  video: { "5": number; "10": number; hd: number; audio: number };
  extend: number;
  edit: number;
  image: { "1k": number; "2k": number };
};

export const DEFAULT_PRICE_TABLE: PriceTable = {
  video: { "5": 2, "10": 4, hd: 1.5, audio: 1 },
  extend: 3,
  edit: 4,
  image: { "1k": 0.5, "2k": 1 },
};

/**
 * 一次任务的售价，人民币元、两位小数。
 *
 * 视频：≤5 秒一档、更长一档；1080p 乘 `hd`，出声再加 `audio`。30 / 45 / 60 秒是
 * 一致性管线（harness）的长片，上游其实是若干 5 秒片，所以按段数 × 5 秒基价算
 * （30s = 6 段 × 2 = 12），倍率与加价照常叠在总额上。
 *
 * `durationSec` 缺失时按 0 算（落到最便宜的一档）——真实调用方 `create.ts` 永远
 * 传归一后的时长，这里只是不让一个畸形请求把计价推进 NaN。
 */
export function priceCny(input: PriceInput, table: PriceTable = priceTable()): number {
  switch (input.mode) {
    case "text_to_image":
      return round2(input.imageResolution === "2k" ? table.image["2k"] : table.image["1k"]);
    case "extend_video":
      return round2(table.extend);
    case "edit_video":
      return round2(table.edit);
    default: {
      const dur = Number.isFinite(input.durationSec) ? Number(input.durationSec) : 0;
      let price = isHarnessDuration(dur)
        ? (dur / 5) * table.video["5"]
        : dur <= 5
          ? table.video["5"]
          : table.video["10"];
      if (input.resolution === "1080p") price *= table.video.hd;
      if (input.generateAudio) price += table.video.audio;
      return round2(price);
    }
  }
}

export function formatCny(n: number): string {
  const value = Number.isFinite(n) ? n : 0;
  return `¥${value.toFixed(2)}`;
}

let tableCache: { raw: string | undefined; table: PriceTable } | null = null;

/**
 * 当前生效的价目表：默认表叠加 `LUMEN_PRICE_TABLE`（同形状的 JSON，可以只写要改的
 * 几项）。坏 JSON 只记一条 warn 并回落默认——一张写错的表不该让整站不能提交
 * （与 `cost.ts` 的 `openaiImagePriceTable` 同一个处理口径）。
 *
 * 浏览器里 `priceTableRaw()` 读不到服务端变量，返回的永远是默认表；客户端要用真表
 * 就把 `/api/me` 的 `prices` 传给 `priceCny` 的第二参。
 */
export function priceTable(): PriceTable {
  const raw = priceTableRaw();
  if (tableCache && tableCache.raw === raw) return tableCache.table;
  const table = raw ? mergeTable(DEFAULT_PRICE_TABLE, parseTable(raw)) : DEFAULT_PRICE_TABLE;
  tableCache = { raw, table };
  return table;
}

type PartialTable = {
  video?: Partial<PriceTable["video"]>;
  extend?: number;
  edit?: number;
  image?: Partial<PriceTable["image"]>;
};

function parseTable(raw: string): PartialTable | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("warn", "LUMEN_PRICE_TABLE 无法解析，售价回落默认表", { length: raw.length });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log("warn", "LUMEN_PRICE_TABLE 不是对象，售价回落默认表", { length: raw.length });
    return null;
  }
  const source = parsed as Record<string, unknown>;
  return {
    video: numbers(source.video, ["5", "10", "hd", "audio"]) as Partial<PriceTable["video"]>,
    extend: number(source.extend),
    edit: number(source.edit),
    image: numbers(source.image, ["1k", "2k"]) as Partial<PriceTable["image"]>,
  };
}

/** 负数与非数字一律丢弃（回落默认那一项），不让一个错字把某一档变成免费或负价。 */
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function numbers(value: unknown, keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const source = value as Record<string, unknown>;
  for (const key of keys) {
    const n = number(source[key]);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

function mergeTable(base: PriceTable, over: PartialTable | null): PriceTable {
  if (!over) return base;
  return {
    video: { ...base.video, ...over.video },
    extend: over.extend ?? base.extend,
    edit: over.edit ?? base.edit,
    image: { ...base.image, ...over.image },
  };
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
