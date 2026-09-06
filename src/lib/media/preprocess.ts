import sharp, { type Sharp } from "sharp";
import { ProviderHttpError } from "@/lib/providers/types";

const MAX_EDGE = 1280;
const MAX_BYTES = 256 * 1024;

/**
 * Decode ceiling, in pixels (plan §3.3, P1).
 *
 * sharp does not care how many *bytes* arrived — it cares how big the bitmap is once
 * decoded, and a 3MB JPEG can legally hold 100 megapixels, i.e. ~400MB of RGBA. The
 * production box runs under `MemoryMax=700M` with two upload slots, so a single
 * unbounded decode is the whole machine. 40MP still covers anything a phone or a
 * full-frame camera produces (a 61MP body is the first thing this refuses).
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Quality ladder. The first pass is the only one that touches the original; every
 * later pass re-compresses the 1280px intermediate, so a file that needs three
 * attempts costs one full-size decode instead of three.
 */
const QUALITY_STEPS = [82, 74, 66] as const;

const DECODE_OPTIONS = { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true } as const;

export async function preprocessImage(input: Buffer): Promise<{
  jpeg: Buffer;
  width: number;
  height: number;
}> {
  let best = await encode(
    sharp(input, DECODE_OPTIONS).rotate().resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    }),
    QUALITY_STEPS[0],
  );
  const intermediate = best.data;

  for (const quality of QUALITY_STEPS.slice(1)) {
    if (best.data.length <= MAX_BYTES) break;
    // Already rotated and already at most MAX_EDGE: nothing to redo but the encode.
    best = await encode(sharp(intermediate, DECODE_OPTIONS), quality);
  }

  if (best.data.length > MAX_BYTES) {
    throw new Error("图片压缩后仍超过 256KB，请换一张更小的图");
  }

  return {
    jpeg: best.data,
    // `resolveWithObject` reports the dimensions of what was just written, which is
    // exactly what the sidecar needs — no second decode to read them back.
    width: best.info.width,
    height: best.info.height,
  };
}

async function encode(pipeline: Sharp, quality: number) {
  try {
    return await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (isPixelLimitError(error)) {
      throw new ProviderHttpError(
        400,
        "invalid_argument",
        "图片像素过大（上限 4000 万像素）",
      );
    }
    throw error;
  }
}

/**
 * sharp reports the ceiling as a plain Error whose message mentions the pixel limit
 * ("Input image exceeds pixel limit"). There is no error code to match on, so the
 * wording is the only handle; anything else keeps propagating as a 500, which is the
 * right answer for a genuinely broken decoder.
 */
function isPixelLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /pixel limit|exceeds pixel/i.test(message);
}

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
