---
name: Genius
description: 深色沉浸的单屏视频工作室：黎明河面 + 玻璃输入卡 + 操作台 / 展览区 + 环形作品画廊。
colors:
  page: "#0a0d12"
  card: "rgba(28,30,36,.92)"
  line: "rgba(214,228,255,.12)"
  muted: "#98999C"
  accent: "#DDE1E8"
  focus: "#C9CED8"
  dark: "#15171c"
rounded:
  card: "26px"
  panel: "22px"
  thumb: "12px"
  chip: "9px"
  button: "12px"
spacing:
  top-bar: "43px"
  console-width: "340px"
  console-gap: "24px"
  exhibit-bottom: "236px"
  composer-width: "708px"
easing:
  primary: "cubic-bezier(.16,1,.3,1)"
  soft: "cubic-bezier(.22,1,.36,1)"
---

# Design System: Genius（原 流光 / Lumen）

来源：`design_handoff/design_handoff_genius_home/README.md`（像素级规格）与 `Lumen v2.dc.html`（定稿原型，两者冲突时以原型为准）。本文是它在仓库里的落地摘要；实现在 `src/components/lumen/LumenHome.tsx` + `src/app/globals.css`，场景在 `src/lib/scene/lumen-three.ts`。

## 方向

整站是一个 `100vh` 的单屏（`body overflow:hidden`）：全屏 WebGL「黎明河面」背景，上面浮着玻璃质感的深色面板。三个视图共用顶栏：

1. **首页**：一行标题「创建你的世界」+ 居中输入卡 + 底部一排 6 张最近成片缩略。
2. **工作室**：用户一开始输入（或点发送）即触发转场——标题与缩略淡出，输入卡滑到右下，左侧滑入「操作台」（滤镜 / 磨皮 / 色彩 / 镜头），右侧展开「展览区」（生成进度与成片）。点选选项时芯片飞入输入框并落成一段提示词，多段之间空一行。顶栏「首页」退出。
3. **作品**：3D 环形画廊（真图 + 倒影，拖拽 / 自动慢转），顶部「视频 n / 图片 n」分栏，底部元信息 + 提示词 + 「用这条提示词再生成」「下载」。

文案全部中文，去掉双语标签、罗马数字与说明性文字。品牌名 **Genius**。

4. **登录页**（`/login`，2026-09-06 新增）：未登录访问三个视图会被服务端 307 到这里。同一套黎明河面背景 + 玻璃卡片，不新增设计语言。

## 颜色

- 页面 `#0a0d12`；卡片 `rgba(28,30,36,.92)`；面板 `rgba(28,30,36,.9)`；面板描边 `inset 0 0 0 1px rgba(214,228,255,.12)`（无外阴影、无 backdrop-filter）。
- 正文白；次要 `#98999C`；芯片文字 `#909093` / hover `#c8c8cb` / 选中白 + `rgba(255,255,255,.17)`；强调浅色 `#DDE1E8`；焦点环 `#C9CED8`；深色字 `#15171c`。
- 发送钮与「下载」浅色渐变 `#f7f7f5 → #cfd2d8`；「登录」深色渐变 `#3d3d3f → #1d1d20`；品牌金属环 `conic-gradient(from 210deg,#f2f4f7,#7f8794 35%,#c9ced8 60%,#5d6472 80%,#f2f4f7)`。
- 灰阶只经透明度产生（导航 .6 / hover .72 / 当前 1；缩略 .78 → 1）。

## 字体

Manrope（400 / 500 / 600）+ Noto Sans SC（400 / 500）作 CJK 回退，经 `next/font/google` 自托管；`-webkit-font-smoothing: antialiased; font-synthesis: none`。

| 角色 | 字号 |
| --- | --- |
| 标题 | `clamp(26px, 2.5vw, 38px)` / 400，line-height 1.1 |
| 正文 / textarea | 15px / 1.5，letter-spacing .007em |
| 导航 | 15px / 500；品牌 18px / 500 |
| 芯片 / 元信息 / 阶段 | 12px（芯片 500，元信息 `#98999C`） |
| 百分比 | `clamp(40px, 5vw, 72px)` / 300，letter-spacing −.03em，tabular |
| 作品提示词 | `clamp(20px, 1.8vw, 28px)` / 500 |

## 结构与尺寸

- **外框** `.frame`：首页 padding `4vh clamp(24px,6vw,120px) 4.5vh`，工作室 `4vh clamp(24px,4vw,72px) 4.5vh 32px`（.8s 过渡）。顶栏高 43。
- **顶栏账号区**（2026-09-06 新增，`.account`）：原「登录」按钮位置改为账号名（`.account__name`，`title`/`aria-label` 带完整邮箱，超宽用 `text-overflow: ellipsis`）+ 「退出」按钮；`≤520px` 隐藏账号名只留退出，避免窄屏顶栏挤爆。退出中禁用按钮并显示「退出中」。
- **顶栏余额**（2026-09-06 阶段一新增，`.account__balance`）：紧跟账号名之后，文案「余额 ¥x」，12px `--muted`、等宽数字，`title`/`aria-label` 带完整「余额 ¥x，在途预留 ¥y」；数据来自 `GET /api/me` 的 `balance`，缺失时不渲染。`≤520px` 与账号名一起隐藏（见「与交接包的有意偏离」）。
- **配额行**（`.composer__quota`，2026-09-06 阶段一改为余额读数）：位于输入卡工具栏芯片旁，文案改为「本次约 ¥x · 余额 ¥y」（原「今日剩余 n/N」，配额降级为防滥用兜底后不再是主读数），`title` 悬浮显示完整「余额 ¥x，在途预留 ¥y，可用 ¥z」；当前配置售价超过可用余额时 `data-empty="true"` 变暗，发送按钮与配额行下方各出现一条提示「当前配置，余额可能不够，请充值」（`.composer__error--balance`，`opacity:1` 常显，比配额提示更醒目）并禁用提交。数据来自 `GET /api/me` 的 `balance`/`prices`，缺失（请求失败）时整行不渲染，不假装数字；配额用尽的旧提示「今日剩余 n/N」/`.composer__error--quota` 仍保留，两者互斥（配额优先判定）。
- **有声 / 无声芯片**（2026-09-06 阶段一新增，仅视频路径，`data-audio="on"|"off"`）：与时长 / 画幅芯片同排，默认「有声」（加价项）；点击切换，estimateCny 与请求体 `generateAudio` 同步跟随。当前 provider 不支持音轨时（`audioAvailable=false`，如可灵关声实例）芯片文案固定「无声 · 暂不可用」、`aria-disabled="true"`、灰一档（`opacity:.45`）且不接受点击——不隐藏入口，说明是这台实例的事而不是产品没这功能。
- **占位卡**（`.works__purged`，作品环 / 缩略）：`artifactsPurgedAt` 非空的任务不渲染播放器或图片，改为一张说明卡：标题「作品已过期清理」（`.works__purged-title`）+ 一行提示文字（`.works__purged-hint`，说明超过留存期已删除原文件），不出现下载/播放/再生成入口，也不向 `/api/media/*` 发请求（该文件已被服务端删除）。
- **输入卡** `.composer`：宽 `min(708px,100%)`，min-height 143，radius 26，padding `24px 22px 12px`，gap 46（工作室 22）。textarea 2 行（工作室 3–7 行随内容）。工具栏：三条路径芯片 + 「8s ⌄」（视频；4 / 6 / 8 / 10 循环，开启 harness 时追加 30 / 45 / 60）+ 「16:9 ⌄」（16:9 / 9:16 / 1:1 循环）+「有声 / 无声」芯片（视频路径，2026-09-06 阶段一新增，见上）；右侧簇：模型名 + 回形针（首帧，选中后白色）+ 30px 发送圆钮（生成中变 `conic-gradient` 进度环 + 22px 深色圆显示百分比）。
- **操作台** `.console`：`left:0; width:340px`，面板 radius 22，padding `22px 20px`，组间 gap 26；每组标题行 12px `#98999C` + 右侧当前选中 11px `#DDE1E8`。
- **展览区** `.exhibit`：`left:364px`，距底 `236px + (rows−3)×23`，16:9 框宽 `min(100%, (100vh − 360px)×16/9, 100cqh×16/9)`（最后一项保证输入卡长高或视口偏高时不压到顶栏），radius 22，`#0c0e13`，`inset 1px` 描边 + `0 30px 80px rgba(0,0,0,.45)`。空态左下「预览」；生成中居中百分比 + 「阶段 · mm:ss」+ 「取消」+ 底边 2px 进度条；完成铺成片（视频留 44px 给原生控制条）+ 底部渐变信息条（元信息 · 下载 · 关闭）；失败态居中「失败 / 已取消 / 已过期」+ 错误信息 + 「重新生成 / 重做失败分镜」「关闭」；2026-09-05 晚（第三轮续）新增：任一分镜标记 `uncertain_submit`（可能已被上游接单，重做会重复付费）时，失败 / 过期态不渲染重做按钮，改显示一行说明（`.exhibit__blocked`，沿用现有令牌、1px 顶线分隔，不新增颜色）。
- **最近成片** `.recent`：`bottom:0` 居中 6 张，`clamp(120px,10.5vw,168px)` 16:9，radius 12，opacity .78，hover 1 + `translateY(−3px)`。
- **作品页**：全屏 `mountRingDark` canvas；顶部胶囊 `padding 4 / radius 12`，按钮 30px 高、选中 `rgba(255,255,255,.17)`；底部左信息（元信息 12px + 提示词），右「角度 · 拖拽旋转」+ 玻璃按钮 + 浅色按钮（40px / radius 12）。环 `R = max(2.6, n×0.58)`，平面 3.0×1.6875 **按原色不透明渲染**（贴图 sRGB 解码，不乘暗、不透底），悬停微放大 1.04；倒影 opacity .12，相机 fov 40 在 `z = −0.6R` 看向 `(0, 0.1, R)`；拖拽 `Δx/innerWidth×0.6`，自动慢转 0.003 圈/秒。

- **登录页** `.auth`（2026-09-06 新增，`src/components/lumen/LoginScreen.tsx`）：与首页同一 `mountDawn` 背景 + 顶栏品牌，居中一张 `.auth__card`（沿用 `.composer` 同款圆角 26 / 描边 / 背景）。卡片内：标题「进入 Genius」+ 一行说明；`.pill` 胶囊里两个 `role="tab"` 按钮切换登录 / 注册；字段用既有 `.field-label` / `.field` 令牌（邮箱、密码，注册态多一栏邀请码 `.field--code`）；错误行 `role="alert"`（`.auth__error`）；提交按钮沿用 `.btn`（发送钮同款浅色渐变），忙碌态禁用并显示「处理中」；底部一行 `.auth__hint` 视 tab 显示邀请码说明或引导切换注册。不新增设计语言、不引入组件库，全部复用现有令牌。

## 动效

- 进场只播一次（根节点 `data-enter` 2.4s 后移除）：brand e-down .58s(.06s)、金属环 e-send、导航 .16/.21/.26s、登录 .34s、标题 e-focus 1s(.3s，含 blur 6px→0)、输入卡 e-panel .9s(.62s)、textarea .88s、芯片行 .94s、右侧簇 1s、缩略 e-up 依次 1.08s + 0.06s。关键帧只写 `from`，结束后不覆盖元素自身的 opacity / transform。
- 工作室转场：标题 opacity→0 / `translateY(−24px)`（.45s / .6s）；缩略 `translateY(28px)`；输入卡 left / top / transform / width .8s soft；操作台延迟 .4s 从 `translateX(−40px)` 进入；展览区延迟 .5s 从 `translateY(24px) scale(.98)` 进入。
- 选项飞入：body 上的固定定位替身芯片，Web Animations 640ms（中途上浮 40px 放大 1.04，终点 textarea 左下角 scale .7 / opacity 0）。
- 芯片 / 按钮所有过渡 .18s ease。`prefers-reduced-motion: reduce` 时动画与过渡时长 .01ms，shader 停止计时，飞入直接落字。

## 背景（WebGL）

`mountDawn`：单 fullscreen quad shader，pixelRatio ≤ 1.5。天空 `#090B12 → #1A1C29`，地平线 `uHorizon = 0.46` 暖色带；fbm 远山；透视河面（多层方向波 + fbm，扭曲天空倒影，菲涅尔 .30→.96，地平线碎光）；薄雾、暗角、±0.02 颗粒；鼠标 `(uMouse−0.5)×0.02` 视差。任务进行中 `setEnergy(1)`：地平线更亮、波幅 +50%、碎光更多；完成 `setEnergy(0)`。

## 状态映射

`view('home'|'works') · studio · prompt · opts{filter,skin,color,cam} · mode(t2v|i2v|t2i) · dur · ratio · first(上传) · job · kind(video|image) · sel · hov · angle`。作品列表来自 `listJobRecords`（成功任务，按 `output.kind` 分视频 / 图片），无成片时回落 `public/lumina` 八张样片。阶段读数：排队中 / 已提交 / 生成中 / 写入中；长片：分镜 / 锁帧 / 生成分镜 n/m / 质检 / 拼接。

## 与交接包的有意偏离

- 展览区宽度多一项 `100cqh×16/9` 约束；输入框 textarea 不画焦点环（卡片即焦点容器）。
- 作品环平面不再按原型"未悬停 0.6 亮度 / 0.98 透明"渲染，而是原色、不透明，悬停改为放大 1.04（用户 2026-09-05 要求保持成片原色彩；0.6 亮度会把画面整体压暗到约 77% 并透出粉色地平线）。
- 保留现有能力并按同一语言落位：生成中「取消」、失败态「重新生成 / 重做失败分镜」、空提示词的 `role="alert"` 错误行、模型名后的「· 模拟」标记、开启 harness 时时长循环追加 30 / 45 / 60 且模型名后带预估。
- **卡片计价与音轨（2026-09-06 阶段一）**：成片与作品元信息里的价钱从美元估算成本改为人民币售价 `¥x.xx`（`priceCny > 0` 才显示，样片与余额模型上线前的旧任务不显示，不追溯计费），不再用 `≈`/`≥` 前缀区分估算/下限——售价是提交时定值，不随执行过程变化；视频卡片额外显示「有声」/「无声」标签（图片不显示，标了是噪音）。
- 顶栏原「登录」按钮已改为账号名 + 「退出」（2026-09-06，`AccessTokenPrompt` 弹窗与访问令牌模式已退役，改为整站会话鉴权 + 独立 `/login` 页，见上「登录页」一节）；「我的」暂无页面，保持 `aria-disabled`。
- 作品页「用这条提示词再生成」对图生视频任务回落为文生视频（首帧无法复用）。
- 窄屏（≤ 900px）：隐藏操作台，展览区与输入卡通栏；定稿以 1440+ 为准。

## 可访问性

原生 `button / textarea / input`；路径用 `role="radio"` + `aria-checked`，操作台芯片 `aria-pressed`，作品分栏 `role="tab"` + `aria-selected`；焦点环 2px `#C9CED8` offset 3px；错误 `role="alert"`；展览区 `aria-live="polite"`；工作室未展开时操作台 / 缩略 `aria-hidden` 且移出 tab 序。
