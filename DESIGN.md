---
name: Genius
description: 侧栏 + 五视图 + 悬浮创作面板的深色 App 壳；主页瀑布流真实作品，创作面板接真后端，智能体 / 画布 / 订阅为像素复刻的本地交互。
colors:
  page: "#0a0a0b"
  side: "#0c0c0d"
  card: "#131316"
  sub-card: "#101013"
  panel: "#16161a"
  line: "rgba(255,255,255,.07)"
  panel-line: "rgba(255,255,255,.09)"
  chip: "rgba(255,255,255,.06)"
  chip-on: "rgba(255,255,255,.14)"
  chip-hover: "rgba(255,255,255,.10)"
  accent-gradient: "linear-gradient(90deg,#ff8a3d,#ff4d8d 60%,#a855f7)"
  credits: "#f0d9a8"
  sub-pink: "#ff8fb0"
rounded:
  panel: "14-16px"
  card: "12px"
  chip: "8-9px"
  thumb: "12px"
  button: "50%（圆钮）"
spacing:
  side-width: "212px"
  side-collapsed: "56px（≤900px）"
  top-bar: "56px"
  composer-max-width: "980px"
  create-content-bottom: "236px"
easing:
  fast: ".16s ease"
  transform: ".2s"
  pop: "cubic-bezier(.22,1,.36,1)"
---

# Design System: Genius App（2026-09-06 晚，前端整体换壳）

来源：`design_handoff/design_handoff_genius_app/README.md`（规格）+ `Genius App.dc.html`（定稿原型，两者冲突以原型为准）。方案与实施记录见 `docs/plan-ui-genius-app.md`（含 §7/§7.1 DOM 契约）。取代此前 `design_handoff_genius_home` 的单屏三视图设计（黎明河面 / 操作台 / 展览区 / 环形作品画廊 / 丝绸幕布，已从工作区连同旧交接包一并删除）。

实现在 `src/app/(shell)/`（路由）+ `src/components/genius/`（组件）+ `src/app/globals.css` + `src/app/styles/{agent,canvas,subscription}.css`（样式）。

## 方向

整站是**侧栏 + 内容区**的传统 App 布局，不再是单屏 3D 场景：

```
<shell flex row>
  <aside 212px>             品牌 + 五项导航（主页/创作/智能体/画布/订阅） + 页脚
  <column flex:1 position:relative>
    <header 56px>            视图标题 + 右侧账户簇
    <main flex:1 overflow:auto>   ← 唯一滚动容器
    <composer / bar>          position:absolute，锚在 column，main 的兄弟节点
  </column>
</shell>
```

**关键约束**：悬浮创作面板（`Composer`）必须是 `main` 的兄弟节点，不能塞进滚动容器——放进去会随内容滚走；`main` 不为它预留 `padding-bottom`，也不加遮罩渐变（面板本身不透明底 + 强阴影即可）。窄屏（≤900px）侧栏收成 56px 图标栏（`clip-path` 隐藏文字，可访问名靠 `aria-current`/`title` 兜底，见「与交接包的有意偏离」）。

## 五个视图

1. **主页 `/`**：活动横幅占位槽 → 标签页 视频 / 图片 / 模板 / 挑战（本轮为给文生图作品加入口新增「图片」，模板/挑战 `aria-disabled`）→ 分类芯片（仅样式）→ 瀑布流 `columns:220px 5` 展示用户真实作品（`jobs` 中 `status==="succeeded"`，按 `output.kind` 分视频/图片），卡片标题胶囊 + hover 上浮，点击开详情浮层（播放器/图片 + 元信息 +「用这条提示词再生成」+「下载」）；`artifactsPurgedAt` 非空显示「作品已过期清理」占位卡；无作品用样片占位并提示「还没有作品」。底部收起态输入条点击展开创作面板。
2. **创作页 `/create`**：上部「当前任务」区（阶段行 / 百分比 / 分镜 n/m / 成片 / 失败原因 / 取消 / 重新生成；`retryBlocked` 非空时显示阻断说明并隐藏「重新生成」；`artifactsPurgedAt` 非空同样禁止重试）+ 下方「最近任务」列表；创作面板默认展开。内容块底部留白 236px（`main` 本身不留，避免主页等其它视图也被顶开）。
3. **智能体 `/agent`**：首屏渐变标题 + 输入卡 + 技能卡片网格、四个下拉（文本/生图/视频模型、技能+悬停预览卡）、技能广场（`/agent?view=plaza` 或本地 state）、历史抽屉、会话页（本地 state，占位对话）——像素复刻 + 本地交互，占位数据，不发请求。
4. **画布 `/canvas`**：空态 → 900×620 作者坐标场景层（`fit×zoom` 缩放）→ 节点/类型菜单/富文本条/提示词面板/模型列表/工具箱抽屉/应用工具落节点/骨架→结果（`setTimeout` 模拟）/视频节点；左侧工具栏、左下控制条、右上浮层。同样本地交互，不发请求。
5. **订阅 `/subscription`**：我的方案卡（⚡ 读真实积分，每日/会员 0，已购=积分）+ 年月切换 + 四档卡片；按钮点击 toast「即将上线」。

## 颜色 / 令牌

见文首 front matter；细节按交接包 §1：正文 `#fff`，次要 `#c9c9ce`/`#a9aab0`，弱色 `#7d7e84`，占位 `#6f7075`，禁用 `#4f5056`；主强调渐变只用于主按钮/发送钮/开关轨道/活动徽标；积分色 `#f0d9a8`；订阅粉 `#ff8fb0`；导航高亮图标转主题色（默认 `#ff8a3d`）。画布底 `#0e0e10` + 点阵 `radial-gradient(rgba(255,255,255,.075) 1px, transparent 1px)`。

## 字体 / 字号

Manrope + Noto Sans SC 回退（400/500/600/700），`-webkit-font-smoothing:antialiased`，经 `next/font/google` 自托管（沿用旧配置）。视图标题 14/600；区块标题 14–15/600-700；正文 13–14；芯片 12–12.5；元信息 11–11.5；智能体大标题 `clamp(26px,3.4vw,44px)`/600；画布节点正文 11、标签 13。

## 圆角 / 高度 / 阴影 / 动效

圆角：面板 14–16、卡片 12、芯片/按钮 8–9、缩略 12、圆钮 50%。高度：顶栏 56、导航项 40、主芯片 30、面板内小芯片 28、主按钮 30（面板内）/40–42（订阅卡）。阴影：悬浮面板 `0 20px 56px rgba(0,0,0,.65)`；卡片仅 inset 描边，无外阴影。动效：过渡 `.16s ease`（颜色/背景）、`.2s`（变换）；进场 `fade-up .35s`、`pop-in .2–.3s cubic-bezier(.22,1,.36,1)`、抽屉 `slide-in .28s`；`prefers-reduced-motion` 时长归零。

## 状态映射

客户端唯一状态所有者是 `src/components/genius/ShellContext.tsx`（`ShellProvider`/`useShell`），主页与创作页共用同一个 Provider 实例。关键字段：

- 能力与账号：`caps`（`mock/harness/videoDurations/videoAspectRatios/imageAspectRatios/videoModel/imageModel/audioAvailable/initialEmail/initialJobs`，由 `(shell)/layout.tsx` 服务端下发）、`me`（`GET /api/me`）、`credits`（`Math.round(availableCny*100)`，¥1=100 积分仅显示，余额模型与后端计费不变）。
- 任务：`jobs`、`currentJob`（派生值 = 显式选中的那条 ?? 最新一条，`setCurrentJob(null)` 才真正清空，方案 §7.1 #8）、`busy`/`working`、`cancel`/`retry`。
- 面板：`open/tab(video|image|audio)/mode(VIDEO_MODES 之一，只有"图文"接后端)/collapsed/pop(null|specs|model|buddy|picker)/prompt/res/imageRes/ratio/ratios/dur/durs/audio/multi/image(Frame:首帧上传)/nativeMode(text_to_video|image_to_video|text_to_image)/price/sendCredits/balanceShort/quotaExhausted/error/notice`。
- 提交：`submit()` 走 `createJobBodySchema`（strict，无 `model` 字段），幂等 key 一次逻辑创作一个（`idempotencyKey.current ??= newIdempotencyKey()`，提交成功清空，任何面板改动作废）。

## 与交接包的有意偏离

- 规格弹层无「预览模式」开关与「剩余试用」文案（后端没有配额档位这个概念）；分辨率只列服务端枚举 `480P/720P/1080P`（图片 `1K/2K`），宽高比/时长同样只列服务端下发的枚举，不画交接包里的 21:9 等占位档。
- 模型芯片只读文案（`caps.videoModel`/`imageModel`，mock 模式后缀「· 模拟」），不做下拉——请求体 schema 没有 `model` 字段，选了也无处可发。
- `.composer__specs` 用 `font-size:0` 的分隔 `span` 保证 `textContent` 精确等于 `720P | 16:9 | 5s`（e2e 依赖精确字符串）。
- 创作页内容块底部留白 236px，`main` 本身不留（避免其它视图也被顶开）。
- 图片页图片槽置灰显示「即将上线」（后端图片路径不支持首帧）。
- 创作面板关闭态仍留在 DOM（`hidden` + `data-open="false"`），不是条件渲染，便于状态保留与 e2e 断言。
- 窄屏（≤900px）侧栏收成 56px 图标栏，导航文字用 `clip-path` 隐藏而非 `display:none`。
- 素材选择弹窗「已创建」页签只展示用户成功图片任务，不可选作首帧（`startUploadId` 仍需走上传通道，本轮未打通「已创建」直接引用），标「即将上线」。
- 头像菜单是 disclosure 语义（按钮+条件渲染的菜单容器），不是 `role="menu"`/`role="menuitem"`。
- 订阅四档价格是原型的美元占位值，未与人民币计费对齐（`docs/plan-ui-genius-app.md` 明确按钮为「即将上线」toast，非真实购买路径）。
- 进入技能广场 / 会话页（智能体视图的子状态）时顶栏标题仍固定显示「智能体」；画布视图顶栏标题固定「画布」——顶栏标题只跟五视图路由走，不感知视图内部 state（未做「视图内子页上报标题」的接口）。
- 工具箱工具名、画布节点标签、部分模型名沿用原型英文占位文案，未本地化。
- 画布结果视频节点用 hover 进度条模拟播放（原型行为），未接入真实 `<video>` play/pause。
- 以下几点是 coder-B 对静态原型的补强（超出「像素复刻+本地交互」的最低要求，但不发请求、不接后端）：技能卡可选中；技能广场筛选、工具箱搜索做成真实本地过滤；会话页可发送并收到占位回复；画布右键弹出节点类型菜单；订阅月付隐藏划线原价。

## 可访问性契约（DOM，e2e 依赖）

| 元素 | 选择器 / 可访问名 |
| --- | --- |
| 壳水合完成 | `.shell[data-ready="true"]`（登录页根节点也是 `.shell`） |
| 侧栏导航 | `nav` 内 `link` 名 `主页/创作/智能体/画布/订阅`，当前项 `aria-current="page"` |
| 顶栏标题 | `.top__title` 文本 = 视图名 |
| 顶栏积分 | `.top__credits`，`aria-label="积分 n"` |
| 收起态输入条（主页） | `button.bar`，名 `描述你想创作的内容` |
| 创作面板 | `.composer[data-open][data-tab][data-mode]`（`data-mode` 报后端模式名，放首帧后 `text_to_video`→`image_to_video`） |
| 面板标签页 | `role="tab"` 名 `视频/图片/音频` + `aria-selected` |
| 模式行 | `role="radio"` 名 `图文/参考/...` + `aria-checked`，不可用项 `aria-disabled="true"` |
| 提示词 | `textarea` `aria-label="提示词"` |
| 规格芯片/弹层 | `.composer__specs` 文本如 `720P \| 16:9 \| 5s`；`.specs-pop` 内 `button[data-res]/[data-ratio]/[data-dur]`，选中 `aria-pressed="true"` |
| 音频开关 | `.composer__audio[role="switch"]`，`aria-checked` |
| 模型芯片 | `.composer__model` |
| 创作按钮 | `button.composer__send` 名 `创作`，`data-busy`，含 `.composer__credits` |
| 错误行 | `.composer__error[role="alert"]` |
| 图片槽 | `.composer__slot` + `input[type=file]`（`aria-label="上传图片"`），有图 `data-state="ready"` |
| 创作页当前任务 | `.task[data-job-id][data-state][data-status]`，`.task__pct/.task__stage/.task__err`，按钮 `取消/重新生成`，`link` `下载` |
| 重试阻断 | `.task__blocked[role="alert"]`，出现时无「重新生成」按钮 |
| 主页瀑布流卡片 | `.masonry__item[data-kind="video|image"][data-purged]`；标签页 `role="tab"` 名 `视频/图片/模板/挑战` |
| 作品详情浮层 | `.work[role="dialog"]`，按钮 `用这条提示词再生成`、`关闭` |
| 头像菜单 | 按钮名 `账户`，菜单内按钮 `退出` |

完整契约与 §7.1 细化假设见 `docs/plan-ui-genius-app.md`。
