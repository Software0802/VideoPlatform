import type { AspectRatio, NativeMode, Resolution } from "@/lib/providers/types";

/**
 * OpenAI `/videos` 兼容中转的模型目录引擎——从 `providers/yman/catalog.ts` 提炼，
 * 与具体上游解耦：表从哪里来（内置常量、`YMAN_MODEL_CATALOG`、relay 配置、
 * `/v1/models` 快照）由调用方以 `table()` 注入，引擎只管别名解析、档位归一与
 * 积分计价。
 */

export type RelayResolution = Extract<Resolution, "720p" | "1080p">;

export type RelayModelSpec = {
  /**
   * 同一个模型在上游的其它叫法（后台内部模型名、旧文档名）。只用于**认出**用户填的
   * 名字，永远不会被发给上游——发出去的 `model` 一律是目录的键，即 `/v1/models` 的
   * 展示名。
   */
  aliases: string[];
  /** 上游认的时长档（秒）。请求里的秒数向上取到最近的一档。 */
  durations: number[];
  resolutions: RelayResolution[];
  ratios: AspectRatio[];
  /** 0 表示这个模型根本不收参考图（纯文生）。 */
  maxReferenceImages: number;
  /**
   * `/v1/models` 快照带来的上游分类。`undefined` = 配置里手写的条目，按视频模型
   * 参与产品生成；快照里的 image / chat 模型不生成视频产品。
   */
  kind?: "video" | "image" | "chat";
  /** 积分 = 分辨率价 + 时长价。键分别是分辨率名与时长的十进制字符串。 */
  credits: {
    resolution: Partial<Record<RelayResolution, number>>;
    duration: Record<string, number>;
    /** 上游 `/models` 直接给单次价（不分档）时的平摊积分。 */
    flat?: number;
  };
};

/**
 * 认不出的模型（配置里填了个目录没有的名字）的兜底能力。取上游最常见的形状，
 * `credits` 留空 → `creditsFor` 落到 unknownCredits。
 */
export const UNKNOWN_RELAY_MODEL: RelayModelSpec = {
  aliases: [],
  durations: [5, 10, 15],
  resolutions: ["720p"],
  ratios: ["16:9", "9:16"],
  maxReferenceImages: 9,
  credits: { resolution: {}, duration: {} },
};

export type RelayCatalog = {
  /** 当前生效的模型表（展示名 → 规格）。 */
  table(): Record<string, RelayModelSpec>;
  /** 任意叫法 → 展示名；认不出原样返回（trim 后）。 */
  resolveModel(name: string): string;
  /** 模型能力；认不出给通用兜底，绝不抛。 */
  specFor(model: string): RelayModelSpec;
  /** 目录是否登记过这个模型（别名也算）。 */
  isKnownModel(model: string): boolean;
  /** 配置里给这个 mode 写的原始模型名（未归一），没配 → undefined。 */
  configuredModel(mode: NativeMode): string | undefined;
  /** 这个 mode 实际要发给上游的模型名（已归一成展示名）。 */
  modelFor(mode: NativeMode): string;
  /** 视频侧能出的画幅（t2v 与 i2v 模型的并集）。 */
  videoRatios(): AspectRatio[];
  /** 视频侧出得了的分辨率档（同上并集）。 */
  videoResolutions(): RelayResolution[];
  /** 参考生视频上限，取 i2v/r2v 模型的（首帧与参考图在上游同一个字段）。 */
  maxReferenceImages(): number;
  /** 请求秒数 → 上游认的时长档，向上取。 */
  normalizeDuration(model: string, sec: number | undefined): number;
  /** 这次调用要预扣多少积分；认不出/缺档落 unknownCredits，绝不返回 0。 */
  creditsFor(model: string, durationSec: number, resolution: RelayResolution): number;
};

export function makeRelayCatalog(opts: {
  table(): Record<string, RelayModelSpec>;
  unknownCredits(): number;
  configuredModel(mode: NativeMode): string | undefined;
}): RelayCatalog {
  function aliasIndex(): Map<string, string> {
    const table = opts.table();
    const index = new Map<string, string>();
    for (const [display, spec] of Object.entries(table)) {
      index.set(display.trim(), display);
      for (const alias of spec.aliases ?? []) {
        const key = alias.trim();
        // 展示名永远赢：别名只在没有同名展示名时才建立指向。
        if (key && !table[key]) index.set(key, display);
      }
    }
    return index;
  }

  function resolveModel(name: string): string {
    const raw = String(name ?? "").trim();
    return aliasIndex().get(raw) ?? raw;
  }

  function specFor(model: string): RelayModelSpec {
    return opts.table()[resolveModel(model)] ?? UNKNOWN_RELAY_MODEL;
  }

  function modelFor(mode: NativeMode): string {
    return resolveModel(opts.configuredModel(mode) ?? "");
  }

  function forEachVideoMode(fn: (mode: "text_to_video" | "image_to_video") => void): void {
    fn("text_to_video");
    fn("image_to_video");
  }

  return {
    table: opts.table,
    resolveModel,
    specFor,
    isKnownModel: (model) => Boolean(opts.table()[resolveModel(model)]),
    configuredModel: opts.configuredModel,
    modelFor,
    videoRatios() {
      const out = new Set<AspectRatio>();
      forEachVideoMode((mode) => {
        const configured = opts.configuredModel(mode);
        if (!configured) return;
        for (const ratio of specFor(configured).ratios) out.add(ratio);
      });
      return [...out];
    },
    videoResolutions() {
      const out = new Set<RelayResolution>();
      forEachVideoMode((mode) => {
        const configured = opts.configuredModel(mode);
        if (!configured) return;
        for (const res of specFor(configured).resolutions) out.add(res);
      });
      return out.size ? [...out] : ["720p"];
    },
    maxReferenceImages() {
      const configured = opts.configuredModel("image_to_video");
      return configured ? specFor(configured).maxReferenceImages : 0;
    },
    normalizeDuration(model, sec) {
      const durations = specFor(model).durations;
      const sorted = [...durations].sort((a, b) => a - b);
      const smallest = sorted[0] ?? 5;
      if (sec == null || !Number.isFinite(sec)) return smallest;
      return sorted.find((d) => d >= sec) ?? sorted[sorted.length - 1] ?? smallest;
    },
    creditsFor(model, durationSec, resolution) {
      const spec = opts.table()[resolveModel(model)];
      if (!spec) return opts.unknownCredits();
      const res = spec.credits.resolution[resolution];
      const dur = spec.credits.duration[String(durationSec)];
      if (res == null && dur == null) return spec.credits.flat ?? opts.unknownCredits();
      // 只缺一半时用已知的一半，另一半按该模型最贵的一档补——宁可高估。
      const resCredits = res ?? maxOf(Object.values(spec.credits.resolution)) ?? 0;
      const durCredits = dur ?? maxOf(Object.values(spec.credits.duration)) ?? 0;
      return resCredits + durCredits;
    },
  };
}

function maxOf(values: (number | undefined)[]): number | undefined {
  const nums = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return nums.length ? Math.max(...nums) : undefined;
}
