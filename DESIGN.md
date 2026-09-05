---
name: 流光 / Lumen
description: 一张纸、两种墨的视频工作室首页（Mono-Color Blueprint）。
colors:
  paper: "#F5F1E8"
  cobalt: "#2148B8"
  terracotta: "#C65F38"
rounded:
  all: "0"
spacing:
  gutter: "64px"
  prompt-width: "760px"
  design-width: "1440px"
rules:
  masthead: "4px"
  frame: "2px"
  hairline: "1px"
---

# Design System: 流光 / Lumen — Blueprint

来源：`design_handoff/design_handoff_lumen_blueprint/README.md`（主交付 `Lumen B Blueprint.dc.html`）。本文是它在仓库里的落地摘要；尺寸、文案与交互以交接包为准，实现在 `src/components/lumen/LumenHome.tsx` + `src/app/globals.css`。

## 方向

一张 Pale Beige 的纸，钴蓝为主墨（约 80%），赭红为辅墨（选中态、进度、强调）。页面是单页：首屏放映机线版 + 居中输入框，下面依次是三条路径、3D 环形画廊、存档网格、任务详情、Footer。只保留三条生成路径：文生视频 / 图生视频 / 文生图。

放弃的语言：圆角、阴影、渐变、模糊、玻璃、卡片、暗色主题、图标库。

## 颜色

- **Paper** `#F5F1E8` 页面与所有面板底色。
- **Cobalt** `#2148B8` 文字、规则线、未选中边框、提交按钮填充。
- **Terracotta** `#C65F38` 选中态、进度条、元信息行、注册标记、hover 目标色。
- 灰阶只允许通过透明度产生（`opacity: .7` 的键名、30% 的进度底线、45% 的 placeholder）。

## 字体

| 角色 | 真实字体 → 替身（`next/font/google`） | 用法 |
| --- | --- | --- |
| Display | Bodoni 72 → Libre Bodoni | 72px 标题、40px 品牌与路径标题、44px 百分比、30px 提示词展示；全部 Italic |
| Mono | Courier New → Courier Prime | 11–13px 大写标签、导航、读数、规则条；tracking 1.2–2px |
| Sans | Avenir Next → Jost | SectionRule 标题 34px/600 |
| CJK | PingFang SC → Noto Sans SC | 21px textarea、18/15/14px 正文 |

## 规则线

4px（masthead）、2px（框 / 选中）、1px（分隔）。选中 = 2px 钴蓝或赭红实线或填充；未选 = 1px 钴蓝实线；hover 只改颜色（钴蓝 → 赭红），过渡 160ms。

## 区块

1. **Hero** `100vh` min 800：全屏 `mountReel`（ink 风格，相机 x −1.3，鼠标微倾斜），header top 32，4px 规则 top 88，标题 left 64 / top 120。输入框 760px 居中（`top:56%`），外框 2px，内部 1px 分隔；折叠面板行 `150px 1fr`；任务读数在框下 16px。
2. **成片** 任务完成后出现，两列 `1fr 1fr`，右侧 2px 框 + 8px 内衬。
3. **三条路径** 三列，上边 1px，罗马数字 → Bodoni 标题 → 说明 → 赭红元信息；点击设路径、展开面板、滚回顶部。
4. **画廊** 外层 `240vh` 内层 sticky `100vh`，`mountWall` ring 布局，58 cells 网点；滚动进度 ×0.5 + 拖拽 Δx/innerWidth×0.6 驱动旋转；hover 变实心，点击进详情。环上最多 12 张，半径 `max(7.2, n×0.9)`。
5. **存档** 4 列 grid gap 40/24，图片 `grayscale(1) contrast(1.05) mix-blend-mode: screen` 叠在钴蓝底上。
6. **任务详情** `1.25fr 1fr`，事实表 `140px 1fr`，五阶段圆点，`Reuse ↑` / `Close`。
7. **Footer** RuledDataStrip：4px 规则 + 四条 mono 文字。

## 场景与状态

- 卷盘转速：working `0.35 + p/100 × 1.9`，done 0.12，error 0.02，idle 0.07；墨线不透明度随 glow 0.22→0.85；穿孔点密度随进度。
- 状态映射：无任务 idle；活动中 working（progress）；succeeded done；failed/expired/canceled error。
- `prefers-reduced-motion`：停止旋转与浮动，页面滚动改为即时。

## 响应式

桌面优先，设计宽 1440。≤1100px：路径单列、存档两列、成片与详情单列。≤720px：gutter 24px、标题 52px、面板行单列。

## 产品原则

单用户本地工作室，用户是创作者本人。主任务流：写提示词 → 选路径与参数 → 提交 → 盯读数 → 拿成片 → 进存档回顾。

1. **画面是主角**：chrome 退后，成片与存档图是页面上最锐利的元素。
2. **工具的效率**：参数一屏可达，状态一眼可读；不为了"干净"而藏功能。
3. **中文优先排版**：字号 / 行高 / 字距为中文阅读优化；mono 只用于读数、标签与元数据。
4. **动效即反馈**：three.js 场景不是装饰，是任务状态的延伸（转速 = 进度，墨密度 = 状态）。

反例：通用 SaaS 仪表盘、渐变文字与玻璃拟态的 AI 落地页、任何让 chrome 比媒体更抢眼的设计。

## 可访问性

原生 `button / select / textarea / input`；路径 / 时长 / 画幅用 `role="radio"` + `aria-checked`；焦点环 2px 赭红；错误 `role="alert"`。
