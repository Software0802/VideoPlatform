import type { Locale } from "@/lib/i18n/locales";

/**
 * 智能体技能（方案 §1）。
 *
 * 一个技能 = 一段拼进 system prompt 的**创作约束**，不是一个开关，也不是一段人设。
 * 20 条逐条对应原型 `AgentView` 里那 20 张卡（12 张首页 + 8 张电商），但名字和描述
 * 从此以这份表为准——原型那份是纯占位。
 *
 * `systemPrompt` 的写法遵循 `.claude/skills/video-prompt/SKILL.md`：
 * 一句场景 + 一个明确的镜头运动 + 光线与色温 + 显式的「保持 X 不变」锁定项；
 * 锁定项写具体可检的事物（发长、衣领形状、光向、色板），不写抽象形容词。有参考图 /
 * 首帧时用「画面中的人物…」指代，不重新描述外貌——重复描述会和参考图打架。
 *
 * 名字与描述是**数据**，不是界面文案，所以两种语言直接挂在这里（而不是塞进
 * `messages/<locale>/agent.ts`）：`GET /api/agent/skills` 两种都下发，前端按当前语言取。
 */

export type LocalizedText = Record<Locale, string>;

export type AgentSkill = {
  id: string;
  name: LocalizedText;
  desc: LocalizedText;
  /** 技能广场的分组，UI 目前只用来排序：`core` 在前，`ecommerce` 在后。 */
  group: "core" | "ecommerce";
  /** 拼进 system prompt 的片段（中文，模型能懂，不随界面语言变）。 */
  systemPrompt: string;
};

const SHARED_LOCK = "锁定项要写具体可检的事物（发型长度、服装颜色与衣领形状、光向与色温、色板），不要写抽象形容词。";

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    id: "car-ad",
    name: { "zh-CN": "汽车广告", en: "Car Commercial" },
    desc: { "zh-CN": "多机位车身特写与环境合成", en: "Multi-angle body detail shots composed into a scene" },
    group: "core",
    systemPrompt: `汽车广告：以车身为主体，镜头在低角度环绕、贴地跟拍、车顶俯拍之间选一种并写明；写清车漆颜色与反光环境（湿地面、隧道灯带、日落逆光）。${SHARED_LOCK}跨镜头保持车型、车漆颜色、轮毂样式与环境时段不变。`,
  },
  {
    id: "cinematic",
    name: { "zh-CN": "电影叙事", en: "Cinematic Story" },
    desc: { "zh-CN": "15 秒短片，剧情 / 动画 / 纪实", en: "15-second shorts: drama, animation or documentary" },
    group: "core",
    systemPrompt: `电影叙事：一句可拍的场景 + 一个明确的镜头运动（缓慢推近 / 侧向平移 / 低角度上升）+ 光线与色温。${SHARED_LOCK}同一角色跨镜头保持面部、发型、服装、光向与色调不变。`,
  },
  {
    id: "game-cg",
    name: { "zh-CN": "游戏 CG", en: "Game Cinematic" },
    desc: { "zh-CN": "角色与场景驱动的过场动画", en: "Character- and world-driven cutscenes" },
    group: "core",
    systemPrompt: `游戏 CG：写清角色的关键装备（武器、披风、纹章）与场景材质（石砖、金属、雾气）。镜头用推近或环绕，不要频繁切换。${SHARED_LOCK}保持角色装备、配色与场景光源方向不变。`,
  },
  {
    id: "game-trailer",
    name: { "zh-CN": "游戏预告", en: "Game Trailer" },
    desc: { "zh-CN": "氛围向概念预告与玩法演示", en: "Mood-driven concept trailers and gameplay teases" },
    group: "core",
    systemPrompt: `游戏预告：以氛围为先，一个镜头只做一件事（揭示环境 / 揭示角色 / 揭示动作）。写明色板与光源类型。${SHARED_LOCK}保持世界观配色与角色剪影不变。`,
  },
  {
    id: "motion-tutorial",
    name: { "zh-CN": "动作教学", en: "Motion Tutorial" },
    desc: { "zh-CN": "分解动作、纠正姿态的教学镜头", en: "Step-by-step motion breakdowns and posture cues" },
    group: "core",
    systemPrompt: `动作教学：机位固定或缓慢平移，全身入画，动作从起势到收势完整可见，避免遮挡与快速剪切。光线均匀、无强阴影。${SHARED_LOCK}保持人物服装、机位高度与背景不变。`,
  },
  {
    id: "lifestyle-ad",
    name: { "zh-CN": "生活方式广告", en: "Lifestyle Ad" },
    desc: { "zh-CN": "模特与场景驱动的日常向广告", en: "Everyday-life ads driven by model and setting" },
    group: "core",
    systemPrompt: `生活方式广告：真实场景（厨房、街角、露台）+ 自然光 + 一个连贯的日常动作。镜头缓慢跟随，不做特技。${SHARED_LOCK}保持人物妆造、服装与一天中的时段不变。`,
  },
  {
    id: "logo-sting",
    name: { "zh-CN": "Logo 演绎", en: "Logo Sting" },
    desc: { "zh-CN": "标识动态演绎与品牌片头", en: "Animated logo reveals and brand stings" },
    group: "core",
    systemPrompt: `Logo 演绎：主体是标识本身，描述它的材质（金属、玻璃、液态）、成形方式与收尾定版。背景干净、不抢主体。${SHARED_LOCK}保持标识比例、字重与品牌主色不变，画面里不要出现别的文字。`,
  },
  {
    id: "ecom-short",
    name: { "zh-CN": "电商短片", en: "Commerce Short" },
    desc: { "zh-CN": "竖屏带货与 UGC 风格口播", en: "Vertical selling clips and UGC-style pieces" },
    group: "core",
    systemPrompt: `电商短片：默认 9:16 竖屏，产品在画面中心偏上，一个卖点一个镜头。光线明亮通透，背景简洁。${SHARED_LOCK}保持产品外观、包装文字与色彩不变。`,
  },
  {
    id: "music-video",
    name: { "zh-CN": "音乐 MV", en: "Music Video" },
    desc: { "zh-CN": "演出、舞蹈与视觉专辑", en: "Performance, dance and visual-album pieces" },
    group: "core",
    systemPrompt: `音乐 MV：写清节奏感来源（人物动作、灯光闪变、镜头运动三选一），一个镜头只用一种。色板要强烈且统一。${SHARED_LOCK}保持人物造型、舞台灯色与色调不变。`,
  },
  {
    id: "product-ad",
    name: { "zh-CN": "产品广告", en: "Product Ad" },
    desc: { "zh-CN": "产品主体或达人出镜的品牌片", en: "Brand films led by the product or a presenter" },
    group: "core",
    systemPrompt: `产品广告：产品是主角，写明材质反光与摆放平面；有人出镜时手部动作要与产品发生关系。${SHARED_LOCK}保持产品形态、标识位置与光源方向不变。`,
  },
  {
    id: "space-tour",
    name: { "zh-CN": "空间漫游", en: "Space Tour" },
    desc: { "zh-CN": "15 秒空间走位与分层运镜", en: "15-second spatial walkthroughs with layered camera work" },
    group: "core",
    systemPrompt: `空间漫游：镜头做单一方向的连续位移（前推 / 侧移 / 上升），穿过门洞或家具形成前景遮挡以显出纵深。${SHARED_LOCK}保持室内配色、材质与自然光方向不变。`,
  },
  {
    id: "vertical-drama",
    name: { "zh-CN": "竖屏短剧", en: "Vertical Drama" },
    desc: { "zh-CN": "分集短剧，反转 / 情感 / 悬疑", en: "Episodic vertical drama: twists, emotion, suspense" },
    group: "core",
    systemPrompt: `竖屏短剧：默认 9:16，人物半身入画，情绪写在具体动作上（攥紧手机、后退半步），不要写心理描写。${SHARED_LOCK}保持人物妆造、场景与光线气氛不变。`,
  },
  {
    id: "ecom-before-after",
    name: { "zh-CN": "电商前后对比", en: "Before / After" },
    desc: { "zh-CN": "并排呈现使用前后的效果差异", en: "Side-by-side before-and-after results" },
    group: "ecommerce",
    systemPrompt: `前后对比：同一机位、同一光线、同一构图，只让被对比的那一项发生变化。${SHARED_LOCK}保持机位、焦段、背景与色温完全不变，否则对比不成立。`,
  },
  {
    id: "ecom-concept",
    name: { "zh-CN": "电商创意概念", en: "Concept Visual" },
    desc: { "zh-CN": "大胆美术方向的产品概念视觉", en: "Bold art-directed product concept visuals" },
    group: "ecommerce",
    systemPrompt: `创意概念：允许超现实布景（悬浮、巨大化、材质置换），但产品本身必须写实。写明色板与主光。${SHARED_LOCK}保持产品外观与标识不被风格化改写。`,
  },
  {
    id: "ecom-macro",
    name: { "zh-CN": "电商细节微距", en: "Macro Detail" },
    desc: { "zh-CN": "突出材质、纹理与做工细节", en: "Material, texture and craftsmanship close-ups" },
    group: "ecommerce",
    systemPrompt: `细节微距：极浅景深，镜头缓慢横移掠过表面，用侧逆光带出纹理。写明材质名词（磨砂金属、真皮纹路、编织面料）。${SHARED_LOCK}保持材质颜色与光向不变。`,
  },
  {
    id: "ecom-mockup",
    name: { "zh-CN": "设备样机", en: "Device Mockup" },
    desc: { "zh-CN": "把界面放进真实设备场景", en: "Interfaces placed into real device scenes" },
    group: "ecommerce",
    systemPrompt: `设备样机：写明设备型号感（无边框手机、笔记本、平板）、摆放平面与环境反射；屏幕内容描述为色块与布局，不要写具体文字。${SHARED_LOCK}保持设备角度、屏幕亮度与环境色温不变。`,
  },
  {
    id: "ecom-exploded",
    name: { "zh-CN": "结构爆炸图", en: "Exploded View" },
    desc: { "zh-CN": "拆解产品结构，逐层展示", en: "Product structure taken apart layer by layer" },
    group: "ecommerce",
    systemPrompt: `结构爆炸图：部件沿同一轴向均匀散开，间距一致，背景纯色。镜头缓慢环绕或不动。${SHARED_LOCK}保持部件比例、材质与排列顺序不变。`,
  },
  {
    id: "ecom-flatlay",
    name: { "zh-CN": "平铺构图", en: "Flat Lay" },
    desc: { "zh-CN": "整洁背景下的产品与道具平铺", en: "Products and props laid out on a clean surface" },
    group: "ecommerce",
    systemPrompt: `平铺构图：正俯拍，物件按网格或对角线排列，留白充足，柔光无硬阴影。写明台面材质与道具种类。${SHARED_LOCK}保持俯拍角度、台面颜色与光线柔硬程度不变。`,
  },
  {
    id: "ecom-ghost",
    name: { "zh-CN": "无人模特", en: "Ghost Mannequin" },
    desc: { "zh-CN": "干净的隐形模特服装呈现", en: "Clean invisible-mannequin garment shots" },
    group: "ecommerce",
    systemPrompt: `无人模特：服装保持穿着时的立体版型，内里领口可见，无人体、无支架、无阴影投在背景上。背景纯白或浅灰。${SHARED_LOCK}保持面料颜色、版型与领口形状不变。`,
  },
  {
    id: "ecom-hero",
    name: { "zh-CN": "主图海报", en: "Hero Poster" },
    desc: { "zh-CN": "可直接上架的主图与横幅", en: "Listing-ready hero images and banners" },
    group: "ecommerce",
    systemPrompt: `主图海报：产品居中或三分点，构图留出上下文案区但**画面里不要生成文字**。光线干净、主体与背景有明确明度差。${SHARED_LOCK}保持产品比例、颜色与背景色板不变。`,
  },
] as const;

const BY_ID = new Map(AGENT_SKILLS.map((s) => [s.id, s]));

export function agentSkillById(id: string | undefined | null): AgentSkill | undefined {
  if (!id) return undefined;
  return BY_ID.get(String(id).trim());
}

/** `GET /api/agent/skills` 的对外形状：不下发 `systemPrompt`（那是我们的提示词资产）。 */
export type AgentSkillPublic = Omit<AgentSkill, "systemPrompt">;

/**
 * 按白名单挑字段，不是「删掉 systemPrompt 剩下的全给」——与 `GET /api/models` 同一个
 * 口径：以后往表里加一个内部字段，不会因为忘了改这里就被顺手发到浏览器。
 */
export function publicSkills(): AgentSkillPublic[] {
  return AGENT_SKILLS.map((s) => ({ id: s.id, name: s.name, desc: s.desc, group: s.group }));
}
