import sharp from "sharp";
import type { CropTarget } from "@/lib/providers/openai-image/rest-map";

const JPEG_QUALITY = 92;

/**
 * Centre-crop the upstream PNG to the requested aspect and re-encode as JPEG (the archive
 * stores `outputs/image.jpg` for every provider).
 *
 * `target` is a pixel box, but only its *ratio* is enforced: when the upstream frame really is
 * the size we asked for, the crop lands exactly on those pixels; when OpenAI ships a different
 * geometry, the largest centred rectangle of the same ratio is taken instead of forcing the
 * literal numbers, so a size change upstream degrades resolution rather than failing the job.
 */
export async function cropToAspect(png: Buffer, target: CropTarget): Promise<Buffer> {
  if (!target) return toJpeg(sharp(png));

  const meta = await sharp(png).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) {
    // Unreadable geometry: let sharp cover-fit into the requested box.
    return toJpeg(sharp(png).resize(target.w, target.h, { fit: "cover", position: "centre" }));
  }

  const aspect = target.w / target.h;
  let width = srcW;
  let height = Math.round(srcW / aspect);
  if (height > srcH) {
    height = srcH;
    width = Math.round(srcH * aspect);
  }
  width = Math.min(srcW, Math.max(1, width));
  height = Math.min(srcH, Math.max(1, height));

  const left = Math.max(0, Math.floor((srcW - width) / 2));
  const top = Math.max(0, Math.floor((srcH - height) / 2));
  return toJpeg(sharp(png).extract({ left, top, width, height }));
}

function toJpeg(pipeline: ReturnType<typeof sharp>): Promise<Buffer> {
  return pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
}
