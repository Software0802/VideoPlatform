/**
 * 画布视图的占位数据。
 * 对应原型 design_handoff/design_handoff_genius_app/Genius App.dc.html 的
 * TOOLS / CANVAS_MODELS / RTE / CTEXT / P 常量。本视图不接后端。
 *
 * 多语言之后这里只留**结构与不随语言变的值**（图片、坐标、工具英文名、分类 id）；
 * 一切给人看的中文文案都挪进了 `src/lib/i18n/messages/<locale>/canvas.ts`，这里存键名。
 */
import type { MessageKey } from "@/lib/i18n/messages";

const LUMINA_NAMES = [
  "2e9cde0e2fb0803e",
  "a72d8b509c55bcd0",
  "a1f3319d0d783e66",
  "f3bfe52263d0656d",
  "d99c0972e1f99b67",
  "a9008119d34b8fc1",
  "5a09f4952b5ad9b6",
  "6f297b60448c30c9",
  "0450bc8d80da9173",
  "5edd8af76572172a",
  "8c0d9035649bec1f",
  "fd7b4eb5c10483f5",
] as const;

export const SHOTS: string[] = LUMINA_NAMES.map((n) => `/lumina/${n}.webp`);

export function shot(i: number): string {
  return SHOTS[((i % SHOTS.length) + SHOTS.length) % SHOTS.length];
}

export const ICON_GRADS = [
  "linear-gradient(140deg,#ff8a3d,#ff4d8d)",
  "linear-gradient(140deg,#5b8cff,#a855f7)",
  "linear-gradient(140deg,#3fd4a0,#1f8f6a)",
] as const;

/** 作者坐标系尺寸（交接包 §6）。 */
export const SCENE_W = 900;
export const SCENE_H = 620;

/** 场景层左侧要给浮动工具栏留出的空间 + 上下留白（fit 公式里的 108 / 72）。 */
export const FIT_PAD_X = 108;
export const FIT_PAD_Y = 16;

/** 分类 id 是 ASCII（筛选判据不能跟着语言变），显示名在字典里。 */
export type ToolCat = "image" | "video" | "audio" | "util";

export type Tool = { name: string; uses: number; cat: ToolCat };

export const TOOL_CAT_ALL = "all" as const;
export const TOOL_CATS = [TOOL_CAT_ALL, "image", "video", "audio", "util"] as const;
export type ToolCatFilter = (typeof TOOL_CATS)[number];

export const TOOL_CAT_KEY: Record<ToolCatFilter, MessageKey> = {
  all: "canvas.cat.all",
  image: "canvas.cat.image",
  video: "canvas.cat.video",
  audio: "canvas.cat.audio",
  util: "canvas.cat.util",
};

/** 工具名是原型里刻意保留的英文（`DESIGN.md`「与交接包的有意偏离」），不进字典。 */
export const TOOLS: Tool[] = [
  { name: "Flight overhead view", uses: 618, cat: "video" },
  { name: "Live2D Motion", uses: 313, cat: "video" },
  { name: "Dutch Angle Motion", uses: 219, cat: "video" },
  { name: "Character Information", uses: 155, cat: "util" },
  { name: "Right Orbit Glide", uses: 101, cat: "video" },
  { name: "Dove Dissolve Transition", uses: 93, cat: "video" },
  { name: "Armor POV", uses: 73, cat: "image" },
  { name: "Storyboard Motion", uses: 65, cat: "util" },
  { name: "Photo retouching", uses: 63, cat: "image" },
  { name: "Suspenseful and thrilling", uses: 63, cat: "audio" },
  { name: "Character Design Reference", uses: 62, cat: "image" },
];

export type CanvasModel = { key: string; name: string; full: string; descKey: MessageKey };

export const CANVAS_MODELS: CanvasModel[] = [
  { key: "Claude", name: "Claude", full: "Claude Sonnet 4.6", descKey: "canvas.model.claude" },
  { key: "Seed", name: "Seed", full: "Seed-2.0-pro", descKey: "canvas.model.seed" },
  { key: "Qwen", name: "Qwen", full: "Qwen-3-max", descKey: "canvas.model.qwen" },
];

export const RTE_ITEMS = ["H1", "H2", "H3", "¶", "B", "I", "A", "1.", "•", "—"] as const;
/** 富文本条当前高亮项的下标（原型固定第 4 个「¶」）。 */
export const RTE_ACTIVE = 3;

export const SKELETON_ROWS = ["92%", "78%", "86%", "64%", "90%", "52%"] as const;

/** 画布节点成本（交接包 §8：画布文本 8 · 画布视频 23）。 */
export const COST_TEXT = 8;
export const COST_VIDEO = 23;
