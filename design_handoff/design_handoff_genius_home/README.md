# Handoff: Genius — 视频工作室首页重构（原 流光 / Lumen）

## Overview
把 VideoPlatform（Next.js App Router，`src/app`）现有的 Blueprint 首页（`src/components/lumen/LumenHome.tsx` + `src/app/globals.css`）替换为一个深色沉浸的单屏体验：
- **首页**：全屏 WebGL「黎明河面」背景 + 一行标题 + 玻璃质感输入卡 + 底部最近成片缩略。
- **工作室模式**：用户一开始输入（或点生成）即触发转场——标题与缩略淡出，输入卡滑到底部，左侧滑入「操作台」（滤镜 / 磨皮 / 色彩 / 镜头 选项面板），右侧展开「展览区」（生成进度与成片）。点选选项时芯片飞入输入框并落成一段提示词，多段之间空一行。
- **作品页**：3D 环形画廊（真图 + 倒影，拖拽 / 自动慢转），顶部「视频 / 图片」分栏切换。

品牌名由「流光 / Lumen」改为 **Genius**。文案全部中文，去掉双语标签、罗马数字与说明性文字。

## About the Design Files
本包内的 `.dc.html` 与 `lumen-fx.js` 是 **HTML 设计参考**（浏览器可直接打开的高保真原型），不是生产代码。任务是在仓库现有环境（Next.js 16 + React 19 + Tailwind 4 + three.js 0.185）中**重建**这些界面：沿用 `SceneHost` 的 canvas 挂载方式、`/api/jobs` 契约（`createJobBodySchema`）、`useJobLive` 轮询、`uploadFile` 首帧上传。shader 与 three.js 场景代码可直接移植到 `src/lib/scene/`（TS 化，补 dispose）。

## Fidelity
**High-fidelity**。颜色、字号、间距、动效时长均为定稿，请像素级还原。原型里的「生成」是 300ms 步进的模拟进度，实现时替换为真实任务进度。

## Screens / Views

### 0. 全局
- 页面 `#0a0d12`，`html/body height:100%; body overflow:hidden`，整站是一个 `100vh` 的单屏。
- 字体：Manrope（400/500/600，Google Fonts）+ Noto Sans SC（400/500）作 CJK 回退；`-webkit-font-smoothing:antialiased`。
- 焦点环：`:focus-visible { outline:2px solid #C9CED8; outline-offset:3px; border-radius:4px }`。链接 hover 色 `#DDE1E8`。
- 首屏进场动画只播一次（见 §Interactions）；`prefers-reduced-motion: reduce` 时动画时长 .01ms，shader 停止计时。

### 1. 背景（WebGL，`lumen-fx.js › mountDawn`）
全屏 `<canvas>`（`position:absolute; inset:0`，pixelRatio ≤ 1.5），单 fullscreen quad shader：
- 天空：`TOP #090B12 → MID #1A1C29` 渐变；地平线 `uHorizon = 0.46`（可调 0.3–0.7），暖色带 `WARM rgb(0.62,0.40,0.30)`，高斯宽度 `7 − 2·energy`。
- 远山：fbm 起伏的剪影，位于地平线上 0.01–0.07。
- 河面：透视映射 `z = 0.07/(d+0.012)`，多层方向波 + fbm 高度场，有限差分求斜率，扭曲天空倒影；菲涅尔 0.30→0.96；地平线光源在水面产生碎光；靠近地平线用 `smoothstep(0,0.10,d)` 抹平防走样。
- 薄雾、暗角、`±0.02` 颗粒。
- 鼠标：`(uMouse−0.5)·0.02` 视差。`setEnergy(1)` 生成中：地平线更亮、波幅 +50%、碎光更多；完成后 `setEnergy(0)`。

### 2. 顶栏（三个视图共用）
`display:flex; align-items:center; justify-content:space-between; height:43px`；框内边距首页 `4vh clamp(24px,6vw,120px) 4.5vh`，工作室 `4vh clamp(24px,4vw,72px) 4.5vh 32px`（padding 过渡 .8s）。
- 左：品牌按钮。金属环 30×30：`conic-gradient(from 210deg,#f2f4f7,#7f8794 35%,#c9ced8 60%,#5d6472 80%,#f2f4f7)`，`box-shadow: inset 0 0 0 8px #0e1117, inset 0 0 0 9px rgba(255,255,255,.18), 0 2px 10px rgba(0,0,0,.4)`；文字 **Genius** 18px/500，letter-spacing −.015em，`text-shadow 0 1px 10px rgba(0,0,0,.3)`。点击回首页并退出工作室。
- 中（绝对居中）：首页 · 作品 · 我的，15px/500，gap 40px，当前 opacity 1，其它 .6，hover .72。
- 右：「登录」40px 高、padding 0 20、radius 12、14px/600，`linear-gradient(180deg,#3d3d3f,#1d1d20)`，`inset 0 1px 0 rgba(255,255,255,.10), 0 2px 14px rgba(0,0,0,.28)`，hover brightness 1.16，active translateY(1px)。

### 3. 首页（默认态）
顶栏下为一个 `position:relative; flex:1` 的舞台，所有元素绝对定位（便于转场）：
- **标题**「创建你的世界」：`left:50%; top:38%; translate(-50%,-50%)`，`clamp(26px,2.5vw,38px)`/400，line-height 1.1，`text-shadow 0 2px 22px rgba(0,0,0,.3)`。
- **输入卡**（`<form>`）：`left:50%; top:50%; translate(-50%,-50%)`，宽 `min(708px,100%)`，min-height 143，radius 26，`background rgba(28,30,36,.92)`，`box-shadow inset 0 0 0 1px rgba(214,228,255,.12)`（无外阴影、无 backdrop-filter），padding `24px 22px 12px`，column，gap 46（工作室 22）。
  - textarea 2 行（工作室 3 行），15px/1.5，letter-spacing .007em，白字，placeholder `#8B8C8E`：文生视频「清晨山谷薄雾，镜头缓慢推进…」/ 文生图「清晨山谷薄雾，一束光落在湖面」/ 图生视频「已选首帧，提示词可选」。Enter 提交，Shift+Enter 换行。
  - 工具栏一行 `align-items:center; gap 14`。左侧芯片 gap 6：三条路径「文生视频 / 图生视频 / 文生图」+「8s ⌄」（4/6/8/10 循环，仅视频）+「16:9 ⌄」（16:9 / 9:16 / 1:1 循环）。芯片：高 30、padding 0 13、radius 9、12px/500、`border 1px solid rgba(255,255,255,.05)`，默认 `color #909093`，背景 `linear-gradient(180deg,rgba(255,255,255,.088),rgba(255,255,255,.05) 45%,rgba(255,255,255,.038))`；选中 `background rgba(255,255,255,.17); color #fff`；hover 文字 `#c8c8cb`。
  - 右侧簇 `margin-left:auto; align-items:center; gap 18; height 30`：模型名 `grok-imagine-video / grok-imagine-image` 12px `#98999C`；回形针（Lucide paperclip 20px，`#A9AAAD`，选中首帧后白色，hover 白）——点击选首帧，自动切图生视频；发送圆钮 30×30，`linear-gradient(180deg,#f7f7f5,#cfd2d8)`，`inset 0 1px 0 rgba(255,255,255,.7), 0 2px 10px rgba(0,0,0,.35)`，深色上箭头 `#15171c` 12px；hover brightness 1.06，active scale .95。生成中：背景改为 `conic-gradient(#DDE1E8 p%, rgba(255,255,255,.14) 0)`，中间 22px 深色圆显示百分比 8px `#DDE1E8`。
- **最近成片**：`bottom:0` 居中一排 6 张，`width clamp(120px,10.5vw,168px)` 16:9，radius 12，opacity .78，`inset 0 0 0 1px rgba(255,255,255,.12), 0 6px 18px rgba(0,0,0,.35)`，hover opacity 1 + translateY(−3px)，gap 14。点击进入作品页并选中该件。

### 4. 工作室模式（`studio = true`）
触发：textarea 首次出现非空内容，或点击发送。退出：顶栏「首页」。
- 标题 opacity→0、translateY(−24px)（.45s / .6s）；缩略 opacity→0、translateY(28px)。
- 输入卡：`left → calc(50% + 182px)`，`top → 100%`，`transform → translate(-50%,-100%)`，宽 `min(708px, calc(100% − 364px))`，.8s `cubic-bezier(.22,1,.36,1)`。
- **操作台** `<aside>`：`left:0; top:0; bottom:0; width:340px`，从 translateX(−40px)/opacity 0 进入，延迟 .4s。面板 radius 22，`rgba(28,30,36,.9)`，inset 1px `rgba(214,228,255,.12)`，padding 22 20，组间 gap 26。每组：标题行 12px `#98999C` letter-spacing .04em，右侧当前选中项 11px `#DDE1E8`；选项芯片同上，flex-wrap gap 6。分组与提示词：
  - 滤镜：胶片「胶片颗粒质感，轻微暗角，柔和高光」/ 黑白「黑白影像，高对比，银盐质感」/ 青橙「青橙色调，阴影偏青、肤色偏暖」/ 柔光「柔光滤镜，轻微光晕，低对比」
  - 磨皮：轻度「人物皮肤轻度磨皮，保留毛孔与纹理」/ 中度「人物皮肤中度磨皮，肤色均匀自然」/ 强「人物皮肤强磨皮，柔焦人像效果」
  - 色彩：暖调「整体暖色调，金色阳光氛围」/ 冷调「整体冷色调，蓝灰清晨氛围」/ 高饱和「高饱和色彩，鲜明浓烈」/ 低饱和「低饱和色彩，克制素净」
  - 镜头：缓慢推进「镜头缓慢推进，稳定平滑」/ 环绕「镜头环绕主体，弧形运动」/ 手持「手持镜头，轻微自然晃动」
  - 每组单选，再点同一项取消。
- **展览区**：`left:364px; right:0; top:0; bottom:236px`，居中一个 16:9 框，`width min(100%, calc((100vh − 360px)·16/9))`，radius 22，`#0c0e13`，inset 1px `rgba(214,228,255,.12)` + `0 30px 80px rgba(0,0,0,.45)`，从 translateY(24px) scale(.98) 进入，延迟 .5s。
  - 空态：左下 12px `#98999C`「预览」，背景 `linear-gradient(160deg,rgba(255,255,255,.06),transparent 60%)`。
  - 生成中：居中百分比 `clamp(40px,5vw,72px)`/300 letter-spacing −.03em；下方「阶段 · mm:ss」12px `#98999C`（阶段：排队中 / 已提交 / 生成中 / 写入中）；底边 2px `#DDE1E8` 进度条（width 过渡 .4s）。
  - 完成：框内铺成片（video/poster）；底部渐变条 `rgba(0,0,0,0)→rgba(0,0,0,.55)` padding 14 18，左元信息（路径 · 时长 · 720p · 画幅 · 提示词）12px，右「下载」「关闭」。

### 5. 作品页
- 全屏 `mountRingDark` canvas（`touch-action:none`），进场 e-pop .8s。
- 顶部居中分栏胶囊：padding 4、radius 12、`rgba(34,36,42,.72)` + blur 20；两个 30px 高按钮「视频 n」「图片 n」，选中 `rgba(255,255,255,.17)` 白字。切换时重建环（只挂该类型）。
- 底部：左侧元信息 12px `#98999C` + 提示词 `clamp(20px,1.8vw,28px)`/500；右侧「角度 · 拖拽旋转」+「用这条提示词再生成」（玻璃按钮 40px, radius 12, `linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.07))`）+「下载」（同发送钮的浅色渐变，深色字）。
- 环：`R = max(2.6, n × 0.58)`，平面 3.0×1.6875，下方倒影 opacity .12；相机 fov 40 位于 `z = −0.6R` 看向 `(0,0.1,R)`，鼠标微倾斜；hover 平面变亮（0.6→1.0），点击选中；拖拽 `Δx/innerWidth × 0.6`，另有每秒 0.003 圈的自动慢转（可关）。

## Interactions & Behavior
- **进场（一次）**：brand e-down .58s(.06s)、mark e-send .62s、导航三项 .16/.21/.26s、登录 .34s、标题 e-focus 1s(.3s, 含 blur 6px→0)、输入卡 e-panel .9s(.62s)、textarea .88s、芯片行 .94s、右侧簇 1s、缩略 e-up 依次 1.08s + 0.06s。缓动 `cubic-bezier(.16,1,.3,1)`（primary）/ `cubic-bezier(.22,1,.36,1)`（soft）。
- **选项飞入**：点击操作台芯片 → 在 `document.body` 生成同样式的固定定位芯片，Web Animations 640ms：起点为芯片位置，中途 `offset .45` 上浮 40px 并放大 1.04，终点 textarea 左下角 scale .7 / opacity 0；结束后把提示词写入：若该组已有选择先移除旧段，再以 `\n\n` 追加新段。用户手动编辑 textarea 时，按「文本是否仍包含该段」同步选中态。
- **提交**：`mode !== i2v` 时提示词必填；进入工作室、`dawn.setEnergy(1)`、发送钮变进度环；完成后展览区显示成片、`setEnergy(0)`。映射到 `/api/jobs`：mode → text_to_video / image_to_video / text_to_image，durationSec、aspectRatio、resolution 720p、imageResolution 1k、startUploadId。
- 芯片 / 按钮所有过渡 .18s ease。

## State Management
`view('home'|'works'), studio(bool), prompt, opts{filter,skin,color,cam}, mode('t2v'|'i2v'|'t2i'), dur(4|6|8|10), ratio, first(upload), job{progress,startedAt}, result{src,meta}, kind('video'|'image'), sel, hov, drag`。
真实数据：作品列表来自 `listJobRecords`（成功任务，按 output.kind 分视频 / 图片），无成片时回落 `public/lumina` 样片。

## Design Tokens
- 颜色：页面 `#0a0d12`；卡片 `rgba(28,30,36,.92)`；面板描边 `rgba(214,228,255,.12)`；正文白；次要 `#98999C`；芯片文字 `#909093` / hover `#c8c8cb`；强调浅色 `#DDE1E8`；焦点 `#C9CED8`；深色字 `#15171c`；按钮浅渐变 `#f7f7f5→#cfd2d8`；金属环见 §2。
- 圆角：卡片 26 / 面板 22 / 缩略 12 / 芯片 9 / 按钮 12。
- 字号：标题 clamp(26,2.5vw,38)；正文 15；导航 15；芯片 12；元信息 12；百分比 clamp(40,5vw,72)。
- 间距：顶栏高 43；框内边距见 §2；操作台 340 + 24 间隙；展览区距底 236。

## Assets
- `assets/lumina/*.webp`：仓库 `public/lumina/` 占位样片。
- 图标：Lucide `paperclip`、`arrow-up`、`chevron-down`（内联 SVG，currentColor）。
- 字体：Google Fonts Manrope、Noto Sans SC。

## Files
- `Lumen v2.dc.html` — 定稿原型（首页 / 工作室 / 作品）。
- `lumen-fx.js` — `mountDawn`（河面背景）、`mountRingDark`（作品环）、`mountContours`（未用）；`lumen-three.js` — 旧场景（`mountDotField / mountWall`，未用，供参考）。
- `Lumen Baseline (current).dc.html` — 重构前首页对照（依赖 `_ds/mono-color-…`）。
- `support.js` — 原型运行时，仅用于在浏览器打开 `.dc.html`，不移植。

## Screenshots
`screenshots/`（预览窗 924×540 截取，仅示意布局与状态；定稿以 1440+ 宽度为准）：
- 01-home — 首页
- 02-studio-enter — 输入后转场进入工作室
- 03-studio-fly-in — 滤镜 / 色彩 选项已拼入提示词
- 04-studio-generating — 生成中
- 05-studio-done — 生成完成
- 06-works-ring — 作品环形画廊
