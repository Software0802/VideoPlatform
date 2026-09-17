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
  let best = await encode(inputPipeline(input), QUALITY_STEPS[0]);
  const intermediate = best.data;

  for (const quality of QUALITY_STEPS.slice(1)) {
    if (best.data.length <= MAX_BYTES) break;
    // Already rotated and already at most MAX_EDGE: nothing to redo but the encode.
    best = await encode(sharp(intermediate, DECODE_OPTIONS), quality);
  }

  if (best.data.length > MAX_BYTES) {
    // 400 而不是裸 Error：这是「这张图不行」，不是服务端坏了。`jsonError` 对未知异常
    // 一律 500 + `internal`，那个状态码会让前端按「稍后重试」处理一个永远不会好的输入。
    throw new ProviderHttpError(
      400,
      "invalid_argument",
      "图片压缩后仍超过 256KB，请换一张更小的图",
    );
  }

  return {
    jpeg: best.data,
    // `resolveWithObject` reports the dimensions of what was just written, which is
    // exactly what the sidecar needs — no second decode to read them back.
    width: best.info.width,
    height: best.info.height,
  };
}

/**
 * 解码管线的构造。单独一层是因为 sharp 对**明显不是图**的输入（空 buffer 之类）在构造
 * 时就抛，而不是等到 `toBuffer()`——两处都要落到同一条 400 映射上（review 2026-09-15 U-01）。
 */
function inputPipeline(input: Buffer): Sharp {
  try {
    return sharp(input, DECODE_OPTIONS).rotate().resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
  } catch (error) {
    throw asInputError(error);
  }
}

async function encode(pipeline: Sharp, quality: number) {
  try {
    return await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw asInputError(error);
  }
}

/**
 * sharp 的异常 → 对外错误。像素超限与「解不开」都是用户输入的问题（400），其余原样
 * 抛出去按 500 处理——那才是解码器真的坏了。
 */
function asInputError(error: unknown): unknown {
  if (isPixelLimitError(error)) {
    return new ProviderHttpError(400, "invalid_argument", "图片像素过大（上限 4000 万像素）");
  }
  if (isUndecodableError(error)) {
    return new ProviderHttpError(
      400,
      "invalid_argument",
      "无法识别这个图片文件，请换一张 JPG / PNG / WebP 图片",
    );
  }
  return error;
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

/**
 * 「这根本不是一张能解码的图」——选了 `.txt`、改了扩展名、或文件只传了一半。
 *
 * 与像素上限同理，sharp 只给文案不给错误码，所以只能匹配措辞（`Input buffer contains
 * unsupported image format` / `Input buffer has corrupt header` / `Input buffer is empty`
 * 及其 `Input file` 变体）。匹配不上的继续按 500 抛：那才是解码器真的坏了。
 *
 * 不这样包的话（review 2026-09-15 U-01），`jsonError` 会把 sharp 的英文原文当成 500
 * `internal` 的 message 原样下发给浏览器。
 */
function isUndecodableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported image format|corrupt header|(buffer|file) (is|contains) empty|Input (buffer|file) is empty|premature end|VipsJpeg|VipsPng/i.test(
    message,
  );
}

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
