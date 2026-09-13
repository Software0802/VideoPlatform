import type { AspectRatio, ImageResolution, NativeMode, Resolution } from "@/lib/providers/types";
import { parseAuthed } from "@/lib/client/http";

/**
 * `GET /api/models` 的浏览器侧读取口（阶段 A 契约）。
 *
 * 「产品」是服务端对上游模型的**对外命名**：用户只看得到产品名与它的能力，看不到
 * 供应商（用户 2026-09-06 决定）。所以这里既不猜 provider，也不把产品 id 当成模型名
 * 展示——列表里显示的一律是 `name`。
 *
 * 形状的事实源在服务端（`src/lib/products/`）。这份类型是它的**镜像**：客户端包不能
 * 依赖只跑在服务端的模块，两边加字段时要一起改。为此下面每个字段都过一遍
 * `readProduct` 的白名单校验——服务端多发的字段直接丢掉，少发或发错的整条产品剔除，
 * 与 `auth.ts` 的 `readBalance` / `readQuota` 同一个口径：只信检查过的值。
 */

export type ProductKind = "video" | "image";

/**
 * 音轨能力。`native` = 可控（面板给开关），`uncontrolled` = 出不出声由上游决定
 * （开关禁用，也不该按有声加价），`off` = 恒定无声。
 */
export type ProductAudio = "off" | "native" | "uncontrolled";

export type Product = {
  id: string;
  /** 展示名。UI 里唯一露出的模型标识，不含供应商。 */
  name: string;
  kind: ProductKind;
  modes: NativeMode[];
  resolutions: Resolution[];
  defaultResolution: Resolution;
  aspectRatios: AspectRatio[];
  durations?: number[];
  audio: ProductAudio;
  supportsLastFrame: boolean;
  /** 30 / 45 / 60 长片档位（一致性管线）是否可用；由服务端按 provider 声明，UI 不推断。 */
  supportsLongForm: boolean;
  maxReferenceImages: number;
  imageResolutions?: ImageResolution[];
  /** 供应商 id / 展示名与上游模型展示名（N3.3 起下发，分组与成本档展示用）。 */
  providerId?: string;
  providerName?: string;
  upstreamModel?: string;
  costHint?: "low" | "mid" | "high";
  description: string;
  /** 下拉里 ⚡ 读数的基准价（人民币元），乘 100 就是积分。 */
  samplePriceCny: number;
};

const NATIVE_MODES: readonly NativeMode[] = [
  "text_to_image",
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit_video",
  "extend_video",
];
const RESOLUTIONS: readonly Resolution[] = ["480p", "720p", "1080p"];
const IMAGE_RESOLUTIONS: readonly ImageResolution[] = ["1k", "2k"];
const RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const AUDIO_KINDS: readonly ProductAudio[] = ["off", "native", "uncontrolled"];

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** 只留白名单里认得的值，顺序按服务端下发的来（芯片的显示顺序就是它）。 */
function pickAll<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const hit = allowed.find((a) => a === item);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

function readProduct(raw: unknown): Product | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const name = str(p.name);
  const kind = p.kind === "image" ? "image" : p.kind === "video" ? "video" : null;
  if (!id || !name || !kind) return null;

  const modes = pickAll(p.modes, NATIVE_MODES);
  if (!modes.length) return null;

  const resolutions = pickAll(p.resolutions, RESOLUTIONS);
  const defaultResolution = RESOLUTIONS.find((r) => r === p.defaultResolution);
  const aspectRatios = pickAll(p.aspectRatios, RATIOS);
  const imageResolutions = pickAll(p.imageResolutions, IMAGE_RESOLUTIONS);
  const durations = Array.isArray(p.durations)
    ? p.durations.filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d > 0)
    : undefined;
  const audio = AUDIO_KINDS.find((a) => a === p.audio) ?? "off";

  return {
    id,
    name,
    kind,
    modes,
    // 视频产品必须至少有一档分辨率，否则规格弹层会空着；图片产品用 imageResolutions。
    resolutions: resolutions.length ? resolutions : kind === "video" ? [...RESOLUTIONS] : [],
    defaultResolution: defaultResolution ?? resolutions[0] ?? "720p",
    aspectRatios: aspectRatios.length ? aspectRatios : ["16:9"],
    durations: durations?.length ? durations : undefined,
    audio,
    supportsLastFrame: p.supportsLastFrame === true,
    supportsLongForm: p.supportsLongForm === true,
    maxReferenceImages: Math.max(0, Math.trunc(num(p.maxReferenceImages, 0))),
    imageResolutions: imageResolutions.length ? imageResolutions : undefined,
    providerId: str(p.providerId) || undefined,
    providerName: str(p.providerName) || undefined,
    upstreamModel: str(p.upstreamModel) || undefined,
    costHint:
      p.costHint === "low" || p.costHint === "mid" || p.costHint === "high"
        ? p.costHint
        : undefined,
    description: str(p.description),
    samplePriceCny: Math.max(0, num(p.samplePriceCny, 0)),
  };
}

/**
 * 当前可用的产品列表。服务端只下发**这台实例现在真能跑**的产品，所以这里不做任何
 * 「有没有 key」的判断——列表里出现的就是可选的。
 *
 * 拉失败时抛，由调用方决定回落（面板会退回服务端下发的 `caps.*` 枚举，界面照常可用）。
 */
export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch("/api/models", { cache: "no-store" });
  const data = await parseAuthed<{ products?: unknown }>(res, "无法读取模型列表");
  const raw = Array.isArray(data.products) ? data.products : [];
  return raw.map(readProduct).filter((p): p is Product => p !== null);
}

/** 这个产品接不接得下这条路径。 */
export function supportsMode(product: Product, mode: NativeMode): boolean {
  return product.modes.includes(mode);
}

/**
 * 任务卡 / 作品卡上的产品名。
 *
 * `JobPublic` 的 `product` / `productName` 由后端在阶段 A 一并加上；这里用结构化读取
 * 而不是直接取字段，好让前端在后端落地前后都能编译，也不会因为老任务没有这两个字段
 * 而渲染出 `undefined`——那种记录回落调用方给的旧文案。
 */
export function productNameOf(job: unknown): string | null {
  if (!job || typeof job !== "object") return null;
  const name = (job as { productName?: unknown }).productName;
  return typeof name === "string" && name.trim() ? name : null;
}
