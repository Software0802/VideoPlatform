# Design

流光（Lumen）视觉系统 —— 「私人放映厅 / 调色棚」。暗场吸光，钨丝灯暖金，chrome 退后，画面是主角。

## Visual Theme

- **场景**：深夜的调色棚。环境光是屏幕本身；界面像黑色吸光绒布，媒体内容是唯一的光源。
- **色彩策略**：Restrained —— 暖调中性色（向钨丝灯 hue 80 微倾）+ 单一琥珀强调色（≤10% 面积）。冷钢蓝仅作信息色点缀。
- **物理隐喻**：放映机（卷轴、光束、尘埃）、胶片（齿孔、片格）、读数屏（mono 字体）。动效有机械重量，不用弹跳。

## Color

全部使用 OKLCH。对比度目标：正文 ≥4.5:1，大字号/图标 ≥3:1。

| Token | 值 | 用途 |
| --- | --- | --- |
| `bg` | `oklch(0.160 0.005 80)` | 页面暗场 |
| `panel` | `oklch(0.195 0.006 80)` | 面板、卡片底 |
| `raise` | `oklch(0.235 0.008 80)` | 浮起控件、输入框 |
| `line` | `oklch(0.92 0.01 90 / 10%)` | 发丝分隔线 |
| `line-strong` | `oklch(0.92 0.01 90 / 18%)` | hover / 强调边 |
| `ink` | `oklch(0.920 0.012 90)` | 主文字 |
| `dim` | `oklch(0.760 0.014 85)` | 次要文字 |
| `muted` | `oklch(0.640 0.014 80)` | 元数据、占位（正文级对比度下限） |
| `faint` | `oklch(0.520 0.012 80)` | 仅大标签 / 图标 / 装饰 |
| `accent` | `oklch(0.790 0.105 78)` | 钨丝灯琥珀：主按钮、激活态、进度 |
| `accent-strong` | `oklch(0.850 0.115 82)` | hover / 高光 |
| `accent-ink` | `oklch(0.240 0.030 80)` | 琥珀底上的文字 |
| `ok` | `oklch(0.760 0.090 160)` | 成功 / 已连接 |
| `danger` | `oklch(0.700 0.150 45)` | 失败 / 错误（暖朱红，不用纯红） |
| `info` | `oklch(0.720 0.060 230)` | 信息点缀（放映机冷光），慎用 |

规则：不用渐变文字；不用装饰性玻璃拟态；琥珀只给"动作"与"状态"，不给背景大面积铺色。

## Typography

- **Sans**：`Geist` → `Noto Sans SC` → system。UI 与中文正文。
- **Mono**：`ThreeUI Fragment Mono`（已内置 woff2）→ `Geist Mono`。只用于读数、标签、元数据、状态码。
- **尺度**：11 mono 标签 / 12.5 元数据 / 14 次要正文 / 15 正文 / 17 引言 / 20 h3 / 26 h2 / 34 h1；首页品牌字 clamp(40px, 8vw, 88px)。
- 中文正文行高 1.7，标题 1.25；拉丁标题 letter-spacing ≥ -0.02em；h1–h3 用 `text-wrap: balance`。
- Mono 标签大写 + tracking 0.12–0.2em，但**一个视图最多一处** eyebrow 式标签。

## Layout

- 工作室：左场景栏 `lg:w-[40%]`（min 400px），右主区单列流；表单与「当前任务 + 画廊」双栏在 `xl` 展开。
- 内容最大宽：画廊 / 详情 `max-w-6xl` / `max-w-3xl`，居中。
- 画廊网格：`repeat(auto-fill, minmax(240px, 1fr))`，不打断点。
- 间距节奏：4 / 8 / 12 / 16 / 24 / 40 / 64；卡片内边距 16–20，区间隔 40+。
- z-index 语义刻度：`scene 1 → overlay 10 → sticky 20 → dock 30 → modal 40 → toast 50`。

## Components

- **按钮**：主按钮 = 琥珀实底 + accent-ink 文字，hover 微升 1px + 增亮；次按钮 = 发丝边 ghost。圆角 pill。禁用 50% 透明。
- **输入**：raise 底 + line 边，focus 时边转琥珀 60% + 2px 琥珀光晕（不是蓝框）。占位文字用 `muted`。
- **分段控件**（模式 / 时长）：一条 hairline 轨道，选中格琥珀底 + 深字；禁用格斜纹 + faint。
- **下拉**：原生 select 样式重写（appearance-none + 琥珀 chevron），不用默认白底。
- **文件投放区**：虚线 hairline + 上传图标，就绪态变实线 + 文件名 + ✓。
- **开关**：轨道式 switch，琥珀滑块，不用原生 checkbox。
- **媒体卡**：海报 16:9 + hairline 边；hover 放大 1.03 + 底部渐变浮出提示词；左上 mono 模式徽章。
- **阶段时间线**：排队→提交→生成→落盘→完成 五节点，当前节点琥珀脉冲，完成节点实心。
- **状态芯片**：小圆点 + mono 文字（mock=琥珀 / live=绿 / 错误=朱红）。
- **胶片条**（首页最近成片）：上下齿孔边（repeating-gradient），横向滚动，hover 抬升。

## Motion

- 缓动：`cubic-bezier(0.16, 1, 0.3, 1)`（ease-out-expo）。时长：微交互 140ms / UI 220ms / 场景 480ms。
- 入场：opacity + translateY(10px)，列表 stagger 40ms；内容默认可见，动画只是增强。
- Three.js 场景即状态：idle 慢转 + 呼吸光；working 转速随进度上升 + 钨丝光增强；done 一次柔光脉冲；error 光转朱红。
- `prefers-reduced-motion`：全部动画降级为瞬态 / 交叉淡化；WebGL 场景静止。

## Imagery

- 媒体永远带 `bg-black` 底与 hairline 边框，海报未加载时不留白。
- 颗粒感：页面级 2–4% 胶片噪点（soft-light overlay），场景栏可加扫描线。
- 图标：1.2px 描边线性图标，圆角接头；不用填充式彩色图标。
