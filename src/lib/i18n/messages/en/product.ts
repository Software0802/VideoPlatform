import type { product as zh } from "../zh-CN/product";

/** English strings for `product`; the type forces every zh-CN key to exist here. */
export const product: Record<keyof typeof zh, string> = {
  "product.video-fast.name": "Fast",
  "product.video-fast.desc": "Quickest turnaround, 720p, up to nine reference images.",
  "product.video-standard.name": "Standard",
  "product.video-standard.desc":
    "Steady everyday tier, 720p or 1080p, first/last frame supported (locked to 1080p).",
  "product.video-hd-audio.name": "HD with audio",
  "product.video-hd-audio.desc": "1080p with a native soundtrack; the highest unit price.",
  "product.video-grok.name": "Grok",
  "product.video-grok.desc":
    "The most flexible tier: 1–15 seconds, seven aspect ratios, native audio.",
  "product.image-fast.name": "Image · Fast",
  "product.image-fast.desc": "Quickest image tier, 1K / 2K, seven aspect ratios.",
  "product.image-standard.name": "Image · Standard",
  "product.image-standard.desc": "Steadier detail, 1K / 2K, seven aspect ratios.",
  "product.image-grok.name": "Image · Grok",
  "product.image-grok.desc": "A bolder stylistic tier, 1K / 2K, seven aspect ratios.",
};
