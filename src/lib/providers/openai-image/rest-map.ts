import {
  openaiImageFlexibleSizes,
  openaiImageQuality,
  type OpenaiImageQuality,
} from "@/lib/env";
import { ProviderHttpError } from "@/lib/providers/types";
import type {
  AspectRatio,
  ImageResolution,
  ProviderGenerateRequest,
} from "@/lib/providers/types";

/** The only sizes official gpt-image-1 accepts. `auto` is never produced by our mapping. */
export const OPENAI_OFFICIAL_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
export type OpenAiOfficialSize = (typeof OPENAI_OFFICIAL_SIZES)[number];
/** Flexible upstreams take any `WxH`; both paths flow through this type. */
export type OpenAiSize = OpenAiOfficialSize | `${number}x${number}`;

export type OpenAiQuality = OpenaiImageQuality;

/**
 * 这条生图通道的两个形状开关。原先它们直接读 `OPENAI_IMAGE_*` 环境变量；接第二条
 * 兼容通道（YMan）后必须能按通道分别给，所以提成参数——不传就还是读环境变量，
 * 官方 / ccgoai 那条路径逐字不变。
 */
export type OpenaiImageShape = {
  /** 上游是否接受任意 16 的倍数尺寸（官方 gpt-image-1 只有三档固定尺寸）。 */
  flexibleSizes: boolean;
  /** flexible 路径下显式发出的画质档；官方路径不看它（1k→low / 2k→high）。 */
  quality: OpenaiImageQuality;
};

/** 默认形状：`OPENAI_IMAGE_FLEXIBLE_SIZES` / `OPENAI_IMAGE_QUALITY`。 */
export function envImageShape(): OpenaiImageShape {
  return { flexibleSizes: openaiImageFlexibleSizes(), quality: openaiImageQuality() };
}

/** Pixel box to centre-crop the returned PNG into; `null` means ship it as-is. */
export type CropTarget = { w: number; h: number } | null;

/**
 * Official path. The platform offers seven aspect-ratio chips, gpt-image-1 offers three sizes.
 * Ratios that exist upstream are requested directly; the rest are requested at the nearest
 * wider / taller size and centre-cropped locally (see `crop.ts`), so what the user picked is
 * what the archive stores.
 */
const OFFICIAL_ASPECT_MAP: Record<AspectRatio, { size: OpenAiOfficialSize; crop: CropTarget }> = {
  "1:1": { size: "1024x1024", crop: null },
  "3:2": { size: "1536x1024", crop: null },
  "2:3": { size: "1024x1536", crop: null },
  "16:9": { size: "1536x1024", crop: { w: 1536, h: 864 } },
  "9:16": { size: "1024x1536", crop: { w: 864, h: 1536 } },
  "4:3": { size: "1536x1024", crop: { w: 1365, h: 1024 } },
  "3:4": { size: "1024x1536", crop: { w: 1024, h: 1365 } },
};

/**
 * Flexible path (`OPENAI_IMAGE_FLEXIBLE_SIZES=1`). An upstream that honours an arbitrary `size`
 * can render every chip natively, so nothing is cropped away and no pixels are paid for twice.
 * Every side is a multiple of 16 (an upstream requirement) and every pair is the exact ratio.
 * Here the 1k / 2k chip finally means what it says — a pixel tier, not a quality tier.
 */
const FLEXIBLE_ASPECT_MAP: Record<AspectRatio, Record<ImageResolution, OpenAiSize>> = {
  "1:1": { "1k": "1024x1024", "2k": "2048x2048" },
  "16:9": { "1k": "1024x576", "2k": "2048x1152" },
  "9:16": { "1k": "576x1024", "2k": "1152x2048" },
  "4:3": { "1k": "1024x768", "2k": "2048x1536" },
  "3:4": { "1k": "768x1024", "2k": "1536x2048" },
  "3:2": { "1k": "1008x672", "2k": "2016x1344" },
  "2:3": { "1k": "672x1008", "2k": "1344x2016" },
};

const DEFAULT_MAPPING = { size: "1024x1024", crop: null } as const;
const DEFAULT_FLEXIBLE_ASPECT: AspectRatio = "1:1";

/**
 * Which pixels to ask for, and what to trim locally afterwards. `imageResolution` only
 * participates on the flexible path; on the official path it still buys a quality tier
 * (see `mapQuality`) because the three fixed sizes cannot grow.
 */
export function mapAspectToSize(
  aspectRatio?: AspectRatio,
  imageResolution?: ImageResolution,
  shape: OpenaiImageShape = envImageShape(),
): { size: OpenAiSize; crop: CropTarget } {
  if (shape.flexibleSizes) {
    const row = (aspectRatio && FLEXIBLE_ASPECT_MAP[aspectRatio]) || FLEXIBLE_ASPECT_MAP[DEFAULT_FLEXIBLE_ASPECT];
    return { size: row[imageResolution === "2k" ? "2k" : "1k"], crop: null };
  }
  if (!aspectRatio) return { ...DEFAULT_MAPPING };
  const hit = OFFICIAL_ASPECT_MAP[aspectRatio];
  if (!hit) return { ...DEFAULT_MAPPING };
  return { size: hit.size, crop: hit.crop ? { ...hit.crop } : null };
}

/**
 * Official path: the platform's `imageResolution` chip (1k / 2k) becomes a *quality tier*, not a
 * pixel size — gpt-image-1 only ships three fixed sizes, so 2k cannot buy more pixels; it buys
 * the `high` rendering tier at the same 1024/1536 geometry.
 *
 * Flexible path: the chip already bought the pixels, so quality is a separate operator dial
 * (`OPENAI_IMAGE_QUALITY`, default `high`).
 */
export function mapQuality(
  imageResolution?: ImageResolution,
  shape: OpenaiImageShape = envImageShape(),
): OpenAiQuality {
  if (shape.flexibleSizes) return shape.quality;
  return imageResolution === "2k" ? "high" : "low";
}

/**
 * Body for `POST /v1/images/generations`. The prompt is forwarded verbatim — no appended
 * style words, no rewriting, no translation: the operator's console text is the contract.
 * `output_format: png` keeps the upstream frame lossless; the JPEG conversion happens locally
 * after cropping. `quality` is always sent explicitly: an omitted field is billed as `medium`.
 */
export function buildImageRequest(
  req: ProviderGenerateRequest,
  shape: OpenaiImageShape = envImageShape(),
): Record<string, unknown> {
  const { size } = mapAspectToSize(req.aspectRatio, req.imageResolution, shape);
  return {
    model: req.model,
    prompt: req.prompt,
    size,
    quality: mapQuality(req.imageResolution, shape),
    n: 1,
    output_format: "png",
  };
}

/**
 * Scalar fields for `POST /v1/images/edits` (multipart). Same size/quality mapping as
 * generations — what is billed is what was asked for. The reference images themselves are
 * appended by the caller as `image[]` parts (one part per MediaRef); this function stays
 * pure so the field shape is golden-testable without touching the filesystem.
 */
export function buildImageEditFields(
  req: ProviderGenerateRequest,
  shape: OpenaiImageShape = envImageShape(),
): Record<string, string> {
  const { size } = mapAspectToSize(req.aspectRatio, req.imageResolution, shape);
  return {
    model: req.model,
    prompt: req.prompt,
    size,
    quality: mapQuality(req.imageResolution, shape),
  };
}

export type OpenAiImageUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * gpt-image-1 answers synchronously with base64 bytes only — there is no `url` variant and no
 * poll. A response carrying only a `url` is treated as an upstream contract change and fails
 * loudly rather than being downloaded from here.
 */
export function parseImageResponse(data: Record<string, unknown>): {
  png: Buffer;
  usage?: OpenAiImageUsage;
} {
  const list = Array.isArray(data.data) ? data.data : [];
  const first = (list[0] ?? {}) as Record<string, unknown>;
  const b64 = typeof first.b64_json === "string" ? first.b64_json.trim() : "";
  if (!b64) {
    if (typeof first.url === "string" && first.url) {
      throw new ProviderHttpError(
        502,
        "upstream_invalid_response",
        "上游只返回了图片 URL；本 provider 仅支持 b64_json，不下载远端图片",
      );
    }
    throw new ProviderHttpError(502, "upstream_invalid_response", "上游未返回图片");
  }
  const png = Buffer.from(b64, "base64");
  if (png.length === 0) {
    throw new ProviderHttpError(502, "upstream_invalid_response", "上游未返回图片");
  }
  return { png, usage: parseUsage(data.usage) };
}

function parseUsage(raw: unknown): OpenAiImageUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const out: OpenAiImageUsage = {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    totalTokens: num(usage.total_tokens),
  };
  if (out.inputTokens == null && out.outputTokens == null && out.totalTokens == null) {
    return undefined;
  }
  return out;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
