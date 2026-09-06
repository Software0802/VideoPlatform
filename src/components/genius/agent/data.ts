/**
 * 智能体视图的占位数据。
 * 逐条对应原型 design_handoff/design_handoff_genius_app/Genius App.dc.html 顶部常量
 * （SKILLS / PLAZA_EXTRA / TEXT_MODELS / IMG_MODELS / VID_MODELS / ICONS / P）。
 * 本视图不接后端，全部为静态占位。
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

/** 占位样片，实现时替换为真实内容。 */
export const SHOTS: string[] = LUMINA_NAMES.map((n) => `/lumina/${n}.webp`);

export function shot(i: number): string {
  return SHOTS[((i % SHOTS.length) + SHOTS.length) % SHOTS.length];
}

/** 模型图标的渐变色板（原型 ICONS）。 */
export const ICON_GRADS = [
  "linear-gradient(140deg,#ff8a3d,#ff4d8d)",
  "linear-gradient(140deg,#5b8cff,#a855f7)",
  "linear-gradient(140deg,#3fd4a0,#1f8f6a)",
  "linear-gradient(140deg,#f0d9a8,#c9a25e)",
  "linear-gradient(140deg,#e08fc8,#8b5cf6)",
  "linear-gradient(140deg,#8b8b91,#4a4a52)",
] as const;

export function iconGrad(i: number): string {
  return ICON_GRADS[i % ICON_GRADS.length];
}

export const TEXT_MODELS = [
  "自动 · 极速",
  "自动 · 均衡",
  "自动 · 精创",
  "GPT-5.6 Sol",
  "GPT-5.6 Terra",
  "GPT-5.6 Luna",
] as const;

export type ModelItem = { name: string; desc: string; auto?: boolean };

export const IMG_MODELS: ModelItem[] = [
  { name: "自动", desc: "智能体将为此请求选择最佳模型", auto: true },
  { name: "Qwen-image", desc: "价格实惠，性能均衡" },
  { name: "GPT Image 2", desc: "下一代高保真图片模型" },
  { name: "Nano Banana Pro", desc: "先进的图片生成和编辑模型" },
  { name: "Seedream 4.0", desc: "中文语义理解强，构图稳定" },
];

export const VID_MODELS: ModelItem[] = [
  { name: "自动", desc: "智能体将为此请求选择最佳模型", auto: true },
  { name: "Genius V6", desc: "原生音效，导演级运镜，真实物理反馈" },
  { name: "Genius C1", desc: "为影视而生，打斗 / 特效升级，多宫格分镜叙事" },
  { name: "Seedance 2.5", desc: "顶尖视频模型，最长支持 30 秒" },
  { name: "MiniMax H3", desc: "新一代视频生成模型" },
  { name: "FLUX 3", desc: "可通过文本或图片生成带原生音频的视频" },
  { name: "Wan 3.0", desc: "全能视频模型，支持最长 30 秒与多模态参考" },
  { name: "Gemini Omni Flash", desc: "全模态模型，可将文本、图片转为带同步声音的视频" },
  { name: "可灵 O3", desc: "支持最长 15 秒智能多镜头、参考锁定、多说话人音频" },
  { name: "Grok Imagine 1.5", desc: "原生音视频生成" },
  { name: "Veo 3.1", desc: "快速、高性价比的视频生成，适用于快速原型" },
  { name: "Sora 2", desc: "电影级视频生成标准" },
];

export type SkillItem = { name: string; desc: string; uses: string };

/** 首屏「选择一个技能开始」卡片（原型 SKILLS）。 */
export const SKILLS: SkillItem[] = [
  { name: "汽车广告", desc: "多机位车身特写与环境合成", uses: "1.7k" },
  { name: "电影叙事", desc: "15 秒短片，剧情 / 动画 / 纪实", uses: "95" },
  { name: "游戏 CG", desc: "角色与场景驱动的过场动画", uses: "56" },
  { name: "游戏预告", desc: "氛围向概念预告与玩法演示", uses: "33" },
  { name: "动作教学", desc: "分解动作、纠正姿态的教学镜头", uses: "35" },
  { name: "生活方式广告", desc: "模特与场景驱动的日常向广告", uses: "11" },
  { name: "Logo 演绎", desc: "标识动态演绎与品牌片头", uses: "30" },
  { name: "电商短片", desc: "竖屏带货与 UGC 风格口播", uses: "104" },
  { name: "音乐 MV", desc: "演出、舞蹈与视觉专辑", uses: "1.7k" },
  { name: "产品广告", desc: "产品主体或达人出镜的品牌片", uses: "95" },
  { name: "空间漫游", desc: "15 秒空间走位与分层运镜", uses: "56" },
  { name: "竖屏短剧", desc: "分集短剧，反转 / 情感 / 悬疑", uses: "33" },
];

/** 技能广场里额外的电商类技能（原型 PLAZA_EXTRA）。 */
export const PLAZA_EXTRA: SkillItem[] = [
  { name: "电商前后对比", desc: "并排呈现使用前后的效果差异", uses: "1.7k" },
  { name: "电商创意概念", desc: "大胆美术方向的产品概念视觉", uses: "95" },
  { name: "电商细节微距", desc: "突出材质、纹理与做工细节", uses: "56" },
  { name: "设备样机", desc: "把界面放进真实设备场景", uses: "33" },
  { name: "结构爆炸图", desc: "拆解产品结构，逐层展示", uses: "35" },
  { name: "平铺构图", desc: "整洁背景下的产品与道具平铺", uses: "11" },
  { name: "无人模特", desc: "干净的隐形模特服装呈现", uses: "30" },
  { name: "主图海报", desc: "可直接上架的主图与横幅", uses: "104" },
];

export const ALL_SKILLS: SkillItem[] = [...SKILLS, ...PLAZA_EXTRA];

/** 输入卡「技能」芯片上的总数徽标（原型写死 41）。 */
export const SKILL_COUNT = 41;

export const CHAT_TITLE = "生成一组海边黄昏的多镜头分镜";
export const CHAT_SEED_USER = "生成一组海边黄昏的多镜头分镜，镜头由下往上缓慢环绕主角";
export const CHAT_SEED_REPLY = "我接住这个海边黄昏的设定，先把画面氛围与镜头运动方向整理出来。";
export const CHAT_SEED_PROMPT =
  "生成一支海滩氛围短片：主角身着轻薄外套，以自信从容的眼神看向同行者，镜头从低角度缓慢环绕上升，保持优雅、克制的构图。";
export const CHAT_PLACEHOLDER_REPLY = "这是占位回复，智能体尚未接入后端。";
