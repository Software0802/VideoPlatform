# Handoff: 流光 · Lumen — Blueprint 首页 / 工作台 / 画廊

## Overview
将 VideoPlatform（Next.js App Router, `src/app`）现有的暗色 StudioShell 替换为一个面向日常用户的单页体验：首屏放映机线版 + 居中 Agent 输入框（设置折叠成一行），下方是三条路径说明、3D 环形画廊、存档网格、任务详情。品牌：**流光 · Lumen**。仅保留三条生成路径：文生视频 / 图生视频 / 文生图。

## About the Design Files
本包内的 `.dc.html` 与 `lumen-three.js` 是 **HTML 设计参考**（可在浏览器直接打开的高保真原型），不是可直接复制的生产代码。目标是在仓库 `Software0802/VideoPlatform` 现有环境（Next.js + React + Tailwind + three.js）中**重建**这些界面，复用已有的 `GenerateForm` 数据契约（`src/lib/jobs/schema.ts`）、任务轮询（`JobProgress`）和 `SceneHost` 的 three.js 挂载方式。

## Fidelity
**High-fidelity**。颜色、字体、间距、文案均为最终稿；请像素级还原。视觉语言遵循 Mono-Color 设计系统（单/双色印刷风格）：无圆角、无阴影、无渐变、无模糊、结构只靠直线规则（rule）。

## Screens / Views

### 0. 全局
- 纸面 `#F5F1E8`（Pale Beige），钴蓝 `#2148B8` 为主墨（约 80%），赭红 `#C65F38` 为辅墨（选中态、进度、强调）。
- 页面左右内边距 64px。桌面优先，设计宽 1440。
- 所有 `border-radius: 0`，无 box-shadow。
- 交互态：选中 = 2px 钴蓝或赭红实线 / 填充；未选 = 1px 钴蓝实线；hover 只改颜色（钴蓝 → 赭红），过渡 160ms。

### 1. 首屏 Hero（`100vh`, min 800px）
- 背景全屏 `<canvas>`：放映机线版（`lumen-three.js › mountReel`, style `ink`，相机 x 偏移 −1.3 使卷盘偏左），鼠标微倾斜跟随。
- Header（top 32px）：左 `流光` Bodoni 72 Italic 700 40px + `LUMEN` Courier 12px/2px tracking；右导航 Courier 12px 大写 1.5px tracking：`画廊 / Gallery`、`存档 / Archive`、赭红 `Cobalt + Terracotta`。
- 4px 钴蓝横规则，top 88px，左右 64px。
- 标题（left 64, top 120, max 520px）：Bodoni 72 Italic 400 72px / 0.95：`写下一个镜头，／看它转起来。`；下方 Courier 13px/1.7：`Write a shot. Watch it turn.` / `Text to video · image to video · text to image`。
- 左下 Courier 12px 大写：`Reel speed = progress`、`Ink density = status`。右下 RegistrationMark 26px 赭红。

#### 输入框（页面中心，`left:50%; top:56%; translate(-50%,-50%)`, width 760px）
- 外框 2px 钴蓝，纸色填充。内部分隔线 1px 钴蓝。
- 顶栏 12/20px padding，Courier 11px 大写 1.5px：左 `Prompt / 提示词`，右状态 `Idle · 待机` / `Rendering · 渲染中`（赭红）/ `Done · 已完成`。
- Textarea 3 行，PingFang SC 21px/1.55 钴蓝，padding 22 20 10；placeholder 45% 透明。图生视频时 placeholder：`首帧图作为起始画面，提示词可选…`，否则 `雨夜的外滩，一位穿深青色风衣的女人走向江边…`。
- 底栏（flex）：左侧「摘要按钮」 padding 14/20，Courier 12px 大写，赭红 `+`/`−` 字形 + 摘要文案如 `Grok · video · 文生视频 · 8s · 16:9 · 首帧`；右侧提交按钮：钴蓝填充、纸色文字 Courier 13px 700 2px tracking `Generate 生成`（渲染中显示 `Rendering`），padding 0 28，hover 变赭红。
- 折叠面板（点击摘要展开），每行 `grid-template-columns: 150px 1fr`, padding 12/20, 行间 1px 钴蓝：
  1. `路径 / Path`：三个单选（圆点 11px + 文字 13px）：文生视频 / 图生视频 / 文生图；选中赭红。
  2. `模型 / Model`：下划线式 select：`grok-imagine-video`、`grok-imagine-video · fast`、`grok-imagine-image`（选文生图自动切到 image 模型）。
  3. `时长 / Length`（仅视频）：4s / 6s / 8s / 10s，56×36 按钮，选中钴蓝填充。
  4. `画幅 / Ratio`：16:9 / 9:16 / 1:1，同上。
  5. `首尾帧 / Frames`（仅视频）：两个 112×63 缩略按钮 `+ 首帧` → `+ 尾帧`，未选 1px 虚线，选中 2px 赭红并显示图片；选首帧时自动切到图生视频；右侧说明 11px：`首帧即起始画面；尾帧仅保存。`
- 任务读数（提交后出现在框下方 16px）：左 `Job XXXX` 赭红 700 / 阶段 `排队 / Queued → 提交 / Submit → 生成 / Render → 落盘 / Write → 完成 / Done` / 计时 `mm:ss`；1px 钴蓝 30% 底线上叠 3px 赭红进度条；右侧百分比 Bodoni Italic 44px。

### 2. 成片（仅任务完成后显示）
`padding 96 64 40`，两列 1fr 1fr gap 40：左 SectionRule `00 成片 / OUTPUT / 01` + 提示词 PingFang 18px + 元信息赭红 Courier 12px；右 2px 钴蓝框 + 8px padding 的 16:9 图。

### 3. 三条路径 `01 三条路径 / THREE PATHS · ONE BOX`
三列，每列上边 1px 钴蓝，右 margin 40，padding 28 28 32 0：罗马数字 Courier 13px 700 → 标题 Bodoni Italic 40px → 说明 PingFang 15px/1.7 → 元信息赭红 Courier 12px。点击：设置对应路径、展开面板并平滑滚回顶部。文案见 `Lumen B Blueprint.dc.html` 中 `PATHS`。

### 4. 画廊 `02 最近成片 / RECENT · DRAG OR SCROLL TO TURN`
- 外层 `height: 240vh`，内层 sticky 100vh；全屏 canvas（`mountWall`, layout `ring`, R=7.2，网点 58 cells）。滚动进度 ×0.5 + 拖拽偏移 驱动环旋转；鼠标悬停平面时网点变为实心，点击进入详情。
- 左下信息块（纸色背景，顶部 2px 钴蓝线）：`Plate 01 / 08 · 文生视频 · 6s` 赭红 12px + 提示词 Bodoni Italic 30px。右下角度读数 `000°`。

### 5. 存档 `03 存档 / 08 部成片 / OUTPUTS`
4 列 grid gap 40/24。每项：16:9 钴蓝底 + 图片 `grayscale(1) contrast(1.05) mix-blend-mode: screen`（双色印刷效果），1px 钴蓝边（选中 2px 赭红）；下方 Courier 11px `Plate 01` / `文生 · 6s`；提示词 PingFang 14px 单行省略。

### 6. 任务详情（点击存档/画廊后显示，并平滑滚到该区域）
`grid 1.25fr 1fr gap 56`。左：2px 框大图 + `Plate 03 / 08` 赭红 / `文生视频 · 8s · 720p · 16:9`。右：SectionRule `04 任务 / JOB 7F2A9C`，提示词 Bodoni Italic 30px；事实表（140px 1fr，行间 1px）：路径 / 模型 / 时长 / 音轨 / 成本；五阶段圆点行；操作：赭红下划线 `用这条提示词再生成 / Reuse ↑`（回填 prompt 并滚顶），`关闭 / Close`。

### 7. Footer
RuledDataStrip：4px 规则 + `流光 · Lumen` / `Grok Imagine / Native` / `Paper #F5F1E8 · Cobalt #2148B8 · Terracotta #C65F38` / `2026`。

## Interactions & Behavior
- 提交：`phase=working`，进度模拟 → 接真实 `/api/jobs` 轮询；将 `{phase, progress}` 传给 reel：`speed = 0.35 + p/100 × 1.9`（working）、0.12（done）、0.02（error）、0.07（idle）；墨线不透明度随 glow 0.22→0.85；穿孔点密度随 p。
- 画廊：`scroll` 监听计算区间进度；`pointerdown/move/up` 拖拽（Δx/innerWidth × 0.6）。
- `prefers-reduced-motion`：停止旋转与浮动。
- 所有滚动用 `window.scrollTo({behavior:'smooth'})`。

## State Management
`prompt, mode('t2v'|'i2v'|'t2i'), model, ratio, dur, first, last, tray(bool), job{id,p,started,done,mode,dur,ratio}, sel, scroll, drag, detail(index|null)`。映射到现有 `GenerateForm` 的 `mode/aspectRatio/duration/firstFrame/lastFrame/model` 字段；`reference_to_video / edit_video / extend_video` 不再暴露在 UI。

## Design Tokens
- 纸 `#F5F1E8`；钴蓝 `#2148B8`；赭红 `#C65F38`。
- 字体：Bodoni 72 → Libre Bodoni；Courier New → Courier Prime；Avenir Next → Jost；PingFang SC → Noto Sans SC。
- 规则：4px（masthead）、2px（框/选中）、1px（分隔）。
- 尺寸：72/40/30 display，21 textarea，15/14 body，13/12/11 mono；tracking 1.2–2px；按钮最小高 36–48。
- 无圆角、无阴影、无渐变。

## Assets
- `assets/lumina/*.webp`：来自仓库 `public/lumina/`（占位成片）。
- `lumen-three.js`：three.js 0.160 ESM；三个挂载函数 `mountDotField / mountReel / mountWall`，含 shader 源，可直接移植到 `SceneHost` 的 `useEffect`。
- 设计系统组件 `SectionRule / RegistrationMark / RuledDataStrip` 用法见 `_ds/.../_ds_bundle.js`，仓库中请用 Tailwind 复刻（都是 rule + 单行 mono 文字）。

## Files
- `Lumen B Blueprint.dc.html` — 选定方向（主交付）
- `Lumen A Sheet.dc.html` — 备选方向（参考）
- `Lumen Baseline.dc.html` — 现有 UI 还原稿（对照）
- `lumen-three.js` — 三个 three.js 场景
- `assets/` — 图片与字体
