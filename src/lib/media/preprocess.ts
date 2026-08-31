import sharp from "sharp";

const MAX_EDGE = 1280;
const MAX_BYTES = 256 * 1024;

export async function preprocessImage(input: Buffer): Promise<{
  jpeg: Buffer;
  width: number;
  height: number;
}> {
  let quality = 82;
  const pipeline = sharp(input).rotate().resize({
    width: MAX_EDGE,
    height: MAX_EDGE,
    fit: "inside",
    withoutEnlargement: true,
  });

  let jpeg = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
  let meta = await sharp(jpeg).metadata();

  while (jpeg.length > MAX_BYTES && quality > 60) {
    quality -= 8;
    jpeg = await sharp(input)
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    meta = await sharp(jpeg).metadata();
  }

  if (jpeg.length > MAX_BYTES) {
    throw new Error("图片压缩后仍超过 256KB，请换一张更小的图");
  }

  return {
    jpeg,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
