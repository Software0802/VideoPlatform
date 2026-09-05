import { ProviderHttpError } from "@/lib/providers/types";
import type {
  AspectRatio,
  ImageResolution,
  ProviderGenerateRequest,
} from "@/lib/providers/types";

/** The only sizes gpt-image-1 accepts. `auto` is never produced by our mapping. */
export const OPENAI_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
export type OpenAiSize = (typeof OPENAI_SIZES)[number];

export type OpenAiQuality = "low" | "medium" | "high" | "auto";

/** Pixel box to centre-crop the returned PNG into; `null` means ship it as-is. */
export type CropTarget = { w: number; h: number } | null;

/**
 * The platform offers seven aspect-ratio chips, OpenAI offers three sizes. Ratios that
 * exist upstream are requested directly; the rest are requested at the nearest wider /
 * taller size and centre-cropped locally (see `crop.ts`), so what the user picked is what
 * the archive stores.
 */
const ASPECT_MAP: Record<AspectRatio, { size: OpenAiSize; crop: CropTarget }> = {
  "1:1": { size: "1024x1024", crop: null },
  "3:2": { size: "1536x1024", crop: null },
  "2:3": { size: "1024x1536", crop: null },
  "16:9": { size: "1536x1024", crop: { w: 1536, h: 864 } },
  "9:16": { size: "1024x1536", crop: { w: 864, h: 1536 } },
  "4:3": { size: "1536x1024", crop: { w: 1365, h: 1024 } },
  "3:4": { size: "1024x1536", crop: { w: 1024, h: 1365 } },
};

const DEFAULT_MAPPING = { size: "1024x1024", crop: null } as const;

export function mapAspectToSize(aspectRatio?: AspectRatio): { size: OpenAiSize; crop: CropTarget } {
  if (!aspectRatio) return { ...DEFAULT_MAPPING };
  const hit = ASPECT_MAP[aspectRatio];
  if (!hit) return { ...DEFAULT_MAPPING };
  return { size: hit.size, crop: hit.crop ? { ...hit.crop } : null };
}

/**
 * The platform's `imageResolution` chip (1k / 2k) becomes a *quality tier* on OpenAI, not a
 * pixel size: gpt-image-1 only ships three fixed sizes, so 2k cannot buy more pixels — it buys
 * the `high` rendering tier (more output tokens, more detail) at the same 1024/1536 geometry.
 */
export function mapQuality(imageResolution?: ImageResolution): "low" | "high" {
  return imageResolution === "2k" ? "high" : "low";
}

/**
 * Body for `POST /v1/images/generations`. The prompt is forwarded verbatim — no appended
 * style words, no rewriting, no translation: the operator's console text is the contract.
 * `output_format: png` keeps the upstream frame lossless; the JPEG conversion happens locally
 * after cropping.
 */
export function buildImageRequest(req: ProviderGenerateRequest): Record<string, unknown> {
  const { size } = mapAspectToSize(req.aspectRatio);
  return {
    model: req.model,
    prompt: req.prompt,
    size,
    quality: mapQuality(req.imageResolution),
    n: 1,
    output_format: "png",
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
