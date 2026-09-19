/**
 * 画布视图的几何常量与分类词表。
 *
 * 原型（`design_handoff/design_handoff_genius_app/Genius App.dc.html`）的 TOOLS /
 * CANVAS_MODELS / RTE / SKELETON 那几份写死数据已经删掉：工具箱现在读真模板与真作品
 * （`CanvasToolbox.tsx`），节点上的模型选择读 `GET /api/models`，富文本条与骨架屏
 * 没有对应实现。留在这里的都是被渲染的代码用到的值。
 */
import type { MessageKey } from "@/lib/i18n/messages";

/** 作者坐标系尺寸（交接包 §6）。 */
export const SCENE_W = 900;
export const SCENE_H = 620;

/** 节点几何：标签条高与卡宽（连线端点与卡片定位共用）。 */
export const LABEL_H = 22;
export const NODE_W = 260;

/** 场景层左侧要给浮动工具栏留出的空间 + 上下留白（fit 公式里的 108 / 72）。 */
export const FIT_PAD_X = 108;
export const FIT_PAD_Y = 16;

/**
 * 窄屏档（review 2026-09-15 U-02）。`NARROW_W` 与 `canvas.css` 的 `@media (max-width:560px)`
 * 是同一个数；这一档不给左侧工具栏留位（它在这一档不渲染），并且**不按 fit 缩小**——
 * 375 宽下 fit 会算到 0.23，节点缩成指甲盖、删除钮 6×4px，视图实际不可操作。保持 1:1、
 * 靠 `.canvas-scroll` 滚动平移。
 */
export const NARROW_W = 560;
export const FIT_PAD_X_NARROW = 16;
export const MIN_SCALE_NARROW = 1;

/** 手动缩放：在 fit 之上再乘一档，底部工具条的滑杆写它。 */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 0.1;

/** 分类 id 是 ASCII（筛选判据不能跟着语言变），显示名在字典里。 */
export type ToolCat = "image" | "video";

export const TOOL_CAT_ALL = "all" as const;
export const TOOL_CATS = [TOOL_CAT_ALL, "image", "video"] as const;
export type ToolCatFilter = (typeof TOOL_CATS)[number];

export const TOOL_CAT_KEY: Record<ToolCatFilter, MessageKey> = {
  all: "canvas.cat.all",
  image: "canvas.cat.image",
  video: "canvas.cat.video",
};
