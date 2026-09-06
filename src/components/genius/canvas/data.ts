/**
 * 画布视图的占位数据。
 * 对应原型 design_handoff/design_handoff_genius_app/Genius App.dc.html 的
 * TOOLS / CANVAS_MODELS / RTE / CTEXT / P 常量。本视图不接后端。
 */

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

export type ToolCat = "图像生成" | "视频生成" | "音频与人声" | "实用";

export type Tool = { name: string; uses: number; cat: ToolCat };

export const TOOL_CATS = ["全部", "图像生成", "视频生成", "音频与人声", "实用"] as const;

export const TOOLS: Tool[] = [
  { name: "Flight overhead view", uses: 618, cat: "视频生成" },
  { name: "Live2D Motion", uses: 313, cat: "视频生成" },
  { name: "Dutch Angle Motion", uses: 219, cat: "视频生成" },
  { name: "Character Information", uses: 155, cat: "实用" },
  { name: "Right Orbit Glide", uses: 101, cat: "视频生成" },
  { name: "Dove Dissolve Transition", uses: 93, cat: "视频生成" },
  { name: "Armor POV", uses: 73, cat: "图像生成" },
  { name: "Storyboard Motion", uses: 65, cat: "实用" },
  { name: "Photo retouching", uses: 63, cat: "图像生成" },
  { name: "Suspenseful and thrilling", uses: 63, cat: "音频与人声" },
  { name: "Character Design Reference", uses: 62, cat: "图像生成" },
];

export type CanvasModel = { key: string; name: string; full: string; desc: string };

export const CANVAS_MODELS: CanvasModel[] = [
  {
    key: "Claude",
    name: "Claude",
    full: "Claude Sonnet 4.6",
    desc: "擅长复杂推理、长上下文理解和高质量写作",
  },
  { key: "Seed", name: "Seed", full: "Seed-2.0-pro", desc: "中文理解能力强，非常适合创意生成和图片任务" },
  { key: "Qwen", name: "Qwen", full: "Qwen-3-max", desc: "平衡的通用能力，助力高性价比的日常创作" },
];

export const RTE_ITEMS = ["H1", "H2", "H3", "¶", "B", "I", "A", "1.", "•", "—"] as const;
/** 富文本条当前高亮项的下标（原型固定第 4 个「¶」）。 */
export const RTE_ACTIVE = 3;

/** 文本 1 节点的正文（原型 CTEXT）。 */
export const NODE_TEXT_1 =
  "为一款便携式投影仪创作一张 4:5 的社交媒体信息流广告。夜晚的城市屋顶上，三位年轻朋友正在观看投影到白墙上的电影，周围环绕着温暖的串灯。将便携式投影仪置于地面在前景中，清晰展示产品。添加醒目的标题「随时随地，畅享影院」，辅助文案「大屏之夜，随行随实」，并在右下角设置「立刻购买」按钮。写实商业摄影，Instagram 和 Facebook DTC 广告风格，移动端优先构图，版式简洁，文字少而清晰易读。";

/** 空提示词时点发送写入的占位提示词（原型 canvasSend）。 */
export const SEED_PROMPT = "我要生成一个一家人在家里看恐龙摧毁城市的视频";
export const VIDEO_SEED_PROMPT = "根据提示词生成视频";

/** 生成完成后节点里渲染的占位结果（原型 nodeDone）。 */
export const RESULT_BLOCK = {
  title: "便携投影仪 · 社交媒体广告方案",
  concept: "广告概念：「家庭恐龙之夜」",
  sceneLabel: "场景描述",
  scene:
    "核心画面：一家三口坐在客厅地板上，投影仪把恐龙横穿城市的画面投到白墙上，孩子伸手去碰投影里的恐龙。",
  layoutLabel: "广告版式（4:5）",
};

export const SKELETON_ROWS = ["92%", "78%", "86%", "64%", "90%", "52%"] as const;

/** 画布节点成本（交接包 §8：画布文本 8 · 画布视频 23）。 */
export const COST_TEXT = 8;
export const COST_VIDEO = 23;
