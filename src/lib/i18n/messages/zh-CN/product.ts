/**
 * 命名空间 `product`：内置产品目录那几档的展示名与一句话说明。
 *
 * 键是**产品 id**（`src/lib/products/catalog.ts` 的 `DEFAULT_PRODUCTS`），中文值与目录里
 * 的 `name` / `description` 保持一致——目录那份仍是服务端事实源（落进 `job.productName`
 * 的快照、`/api/models` 下发的都是它），这里只负责界面上怎么念。relay 接进来的模型没有
 * 也不需要词条，照旧显示上游给的名字。
 */
export const product = {
  "product.video-fast.name": "快速",
  "product.video-fast.desc": "出片最快的一档，720p，最多九张参考图。",
  "product.video-standard.name": "标准",
  "product.video-standard.desc": "画面稳定的常规档，可选 720p / 1080p，支持首尾帧（首尾帧固定 1080p）。",
  "product.video-hd-audio.name": "高清有声",
  "product.video-hd-audio.desc": "1080p 且自带音轨，单价最高。",
  "product.video-grok.name": "Grok",
  "product.video-grok.desc": "画幅与时长最自由的一档，1–15 秒、七种画幅、自带音轨。",
  "product.image-fast.name": "图片 · 快速",
  "product.image-fast.desc": "出图最快的一档，1K / 2K、七种画幅。",
  "product.image-standard.name": "图片 · 标准",
  "product.image-standard.desc": "细节更稳的常规出图档，1K / 2K、七种画幅。",
  "product.image-grok.name": "图片 · Grok",
  "product.image-grok.desc": "风格更强烈的出图档，1K / 2K、七种画幅。",
} as const;
