# 方案：前端换壳为 Genius App（侧栏 + 五视图 + 悬浮创作面板）

日期 2026-09-06。依据 `design_handoff/design_handoff_genius_app/README.md`（规格）与 `Genius App.dc.html`（原型，两者冲突以原型为准）。取代此前 `design_handoff_genius_home` 的单屏三视图设计（已从工作区删除）。

用户 2026-09-06 拍板：
1. 智能体 / 画布 / 订阅三个无后端视图：**像素复刻 + 本地交互**（下拉、抽屉、节点菜单、年月切换全部做），占位数据，不发请求。
2. 创作面板里后端不支持的模式（参考 / 模板 / 首尾帧 / 编辑 / 动作模仿 / 续写 / 人声、音频页）：**画出来但置灰**，点击无效并提示「即将上线」。
3. 积分口径：**¥1 = 100 积分**换算显示（顶栏 ⚡ 与创作按钮 ⚡），余额模型与后端计费不变。

## 1. 目标与非目标

- 目标：整站 UI 换成交接包的壳与五个视图；创作面板接真实后端（文生视频 / 图生视频 / 文生图），主页瀑布流展示用户真实作品；其余视图按原型复刻本地交互。
- 非目标：不改任何 `/api/*`、`src/lib/jobs`、`src/lib/providers`、`src/lib/billing`、`src/lib/users`、`src/proxy.ts`；不新增后端能力；不做手机端定稿（只做侧栏收窄的最低适配）；不删除 `src/lib/scene`、`src/shaders`、`ClothVeil.tsx`（本轮不再挂载，删除另开一刀）。

## 2. 路由与壳

```
src/app/layout.tsx                 根：字体 + globals.css（不变）
src/app/(shell)/layout.tsx         服务端：读会话 cookie，无会话 redirect("/login")；下发 ShellProps
src/app/(shell)/page.tsx           /            主页
src/app/(shell)/create/page.tsx    /create      创作页
src/app/(shell)/agent/page.tsx     /agent       智能体
src/app/(shell)/canvas/page.tsx    /canvas      画布
src/app/(shell)/subscription/page.tsx /subscription 订阅
src/app/login/page.tsx             不变（已登录 redirect("/")），LoginScreen 换新配色
src/app/{studio,gallery,jobs}      保留现有 redirect("/")
```

- `(shell)/layout.tsx` 是服务端组件，做现在 `src/app/page.tsx` 的事：`sessionUserFromValue` 校验、`listJobRecordsForUser(user.id).slice(0,40).map(toPublic)` 作 `initialJobs`、下发 `videoDurations / videoAspectRatios / videoModel / audioAvailable / mock / harness / initialEmail`。全部放进 `<GeniusShell {...props}>{children}</GeniusShell>`。`export const dynamic = "force-dynamic"`。
- `(shell)/layout.tsx` 同时下发 `imageAspectRatios()`（文生图画幅与视频完全无关，必须分开下发，见旧 `src/app/page.tsx:47-49`）。
- `GeniusShell`（客户端）渲染：`<aside class="side">` + `<div class="col">`（`<header class="top">` + `<main class="main">{children}</main>` + 悬浮层 `<Composer/>`）。**悬浮层是 `main` 的兄弟节点**，`position:absolute` 锚在 `.col`，`main` 不预留 padding-bottom（交接包 §0、§9.1）。
- 页面用 `usePathname()` 决定导航高亮与顶栏标题（主页 / 创作 / 智能体 / 画布 / 订阅）；画布视图把 `.col` 标 `data-view="canvas"`，`main` 改 `overflow:hidden`。
- 顶栏右侧簇：订阅胶囊（跳 `/subscription`）→ 账户芯片（头像首字 + 账号名 + ⚡积分 + 「基础版」）→ 语言 / 通知（仅样式）→ 头像（点击弹出小菜单：邮箱 + 「退出」，`logout()` 后 `window.location.assign("/login")`）。全部 `white-space:nowrap; flex:none`，簇不加 `overflow:hidden`。

## 3. 共享客户端状态

`src/components/genius/ShellContext.tsx`：一个 Provider 挂在 `GeniusShell` 里，持有：

- `me: MePublic | null`（`fetchMe()`，任务终态后重拉）与 `credits = Math.round(availableCny * 100)`。
- `jobs: JobPublic[]`（`initialJobs` 起步，新任务 unshift，`useJobLive` 更新替换）。
- 创作面板状态（主页与创作页共用同一实例，交接包 §8）：`composerOpen, tab(video|image|audio), mode, collapsed, pop, res, ratio, dur, audio, multi, prompt, image(首帧上传), currentJob, busy, error`。
- 能力：`videoDurations / videoAspectRatios / imageAspectRatios / videoModel / audioAvailable / mock / harness`。
- 幂等 key：**一次逻辑创作一个 key**（沿用旧 `LumenHome.tsx:569-583` 的做法）：`idempotencyKey.current ??= newIdempotencyKey()`，提交成功才清空；提交失败（网络抖动、5xx）时复用同一个 key 与同一请求体重试，服务端按 key 回放原任务而不重复计费。用户改了 prompt / 选项后才算新创作，换新 key。

主页收起态输入条点击 → `composerOpen=true`；提交成功 → `router.push("/create")` 并把新任务设为 `currentJob`。

## 4. 创作面板 ↔ 后端映射

| 原型 | 实现 |
| --- | --- |
| 视频页「图文」 | 图片槽为空 → `text_to_video`；放了图 → `image_to_video`（上传走 `uploadFile(file,"start")` → `startUploadId`） |
| 视频页 参考 / 模板 / 首尾帧 / 编辑 / 动作模仿 / 续写 / 人声 | 渲染，`aria-disabled="true"`、颜色 `#4f5056`，点击 toast「即将上线」 |
| 图片页「默认」 | `text_to_image`；选项行只留 `分辨率 | 画幅`（分辨率映射 `imageResolution: 1k/2k`，芯片文案 `1K | 2K`） |
| 音频页 | 整页置灰 + 「即将上线」 |
| 规格弹层 分辨率 | 只显示后端档 `480P / 720P / 1080P`（`resolution`）；「预览模式」开关与「剩余 3 次试用」不做（去掉） |
| 规格弹层 宽高比 | 视频页显示 `videoAspectRatios`、图片页显示 `imageAspectRatios`（各 ≤7 项，无 21:9），线框仍按比例画；切换标签页时若当前画幅不在目标枚举里，回落到该枚举第一项 |
| 规格弹层 时长 | 只显示 `videoDurations`（harness 开启时追加 30/45/60，走 `job.shots` 分镜进度）；5 列网格 |
| 音频开关 | `generateAudio`；`audioAvailable=false` 时开关禁用并标「暂不可用」 |
| 多镜头开关 | 仅样式，不进请求体 |
| 配置面板（粉点） | 仅样式 |
| 模型芯片 | 只读文案 = 服务端 `videoModel`（视频）/ 「gpt-image」类文案（图片，取 `provider` 展示名）；mock 模式后缀「· 模拟」；下拉列表不做（schema 无 `model` 字段） |
| 数量芯片 | 固定 1，仅样式 |
| 创作按钮 ⚡n | `n = Math.round(priceCny(...) * 100)`，价目来自 `me.prices`；余额不足按钮禁用 + 错误行 |
| 创作搭子 / 清空 / 收起 | 搭子仅样式浮层（占位文案）；清空清 prompt 与图片；收起按原型 |
| 素材选择弹窗 | 「已上传」页签接本地文件选择（同一上传通道）；「已创建」列出用户成功图片任务，可选作首帧（`startUploadId` 仍需上传，故本轮已创建页签只展示不可选，标「即将上线」） |

请求体以 `createJobBodySchema`（strict）为准；`idempotencyKey` 规则见 §3。

## 5. 各视图

- **主页 `/`**：横幅占位槽（`clamp(170px,24vh,300px)`，用 `assets/lumina` 一张 webp 复制到 `public/lumina/`）→ 标签页 视频 / 图片 / 模板 / 挑战（「图片」本轮新增以给文生图作品一个入口；模板 / 挑战 `aria-disabled`）→ 分类芯片（仅样式，「全部」选中）→ 瀑布流 `columns:220px 5` 展示 `jobs` 中 `status==="succeeded"` 的作品（视频标签 = `output.kind==="video"`，图片标签 = `image`），卡片左上角标题胶囊显示 prompt 前 12 字，hover `translateY(-3px)`，点击打开作品详情浮层（播放器 / 图片 + 元信息 + 「用这条提示词再生成」回填面板 + 「下载」）；`artifactsPurgedAt` 非空显示「作品已过期清理」占位卡。无作品时用交接包样片占位 + 「还没有作品」提示。底部收起态输入条。
- **创作页 `/create`**：上部「当前任务」区（承接旧展览区：阶段行 / 百分比 / 分镜 n/m / 成片 / 失败原因 / 取消 / 重新生成；`job.retryBlocked` 非空时显示其 `message`（`role="alert"`）并**隐藏**「重新生成」，`retry()` 里也要守卫，语义是上游可能已接单不可重发；`artifactsPurgedAt` 非空同样禁止重试；重试走既有 `retryJob`）+ 下方「最近任务」列表（缩略 + 状态 + 时间 + ⚡价格）；创作面板默认展开。
- **智能体 `/agent`**：首屏、四个下拉（文本 / 生图 / 视频模型、技能 + 悬停预览卡）、技能广场页（`/agent?view=plaza` 或本地 state）、历史抽屉、会话页（本地 state，占位对话）。发送按钮只切到会话页占位，不发请求。
- **画布 `/canvas`**：空态 → 场景层（900×620 作者坐标 + `fit×zoom` 缩放）→ 节点 / 类型菜单 / 富文本条 / 提示词面板 / 模型列表 / 工具箱抽屉 / 应用工具落节点 / 发送后骨架→结果（本地 setTimeout 模拟）/ 视频节点。左侧工具栏、左下控制条、右上浮层。
- **订阅 `/subscription`**：我的方案卡（⚡ 读真实积分，每日 / 会员 0，已购 = 积分）+ 年月切换 + 四档卡片；按钮点击 toast「即将上线」。

## 6. 样式与文件

- 设计令牌全部替换为交接包 §1（页面 `#0a0a0b`、侧栏 `#0c0c0d`、卡片 `#131316`、悬浮面板 `#16161a` 不透明、描边 `.07/.09`、主渐变 `linear-gradient(90deg,#ff8a3d,#ff4d8d 60%,#a855f7)`、积分色 `#f0d9a8`、订阅粉 `#ff8fb0`）。字号 / 圆角 / 高度 / 阴影 / 动效按 §1。
- `src/app/globals.css` 重写为壳 + 主页 + 创作面板 + 创作页 + 登录页；智能体 / 画布 / 订阅各自一个文件 `src/app/styles/{agent,canvas,subscription}.css`，由 `globals.css` 顶部 `@import` 引入（便于并行）。BEM 块名 + `data-*` 状态，不用 Tailwind 工具类，不引组件库 / 图标库（图标内联 SVG，收进 `src/components/genius/icons.tsx`）。
- 组件目录 `src/components/genius/`：`GeniusShell.tsx, ShellContext.tsx, Sidebar.tsx, TopBar.tsx, icons.tsx, composer/Composer.tsx（含 SpecsPop / ModelChip / BuddyPop / AssetPicker）, home/HomeView.tsx, create/CreateView.tsx, agent/AgentView.tsx, canvas/CanvasView.tsx, subscription/SubscriptionView.tsx`。`src/components/lumen/LumenHome.tsx` 删除，`LoginScreen.tsx` 改配色后移到 `genius/LoginScreen.tsx`。
- 原型 `image-slot.js`、`support.js` 不移植。

## 7. DOM 契约（e2e 依赖，coder 与 tester 共同遵守）

| 元素 | 选择器 / 可访问名 |
| --- | --- |
| 壳水合完成 | `.shell[data-ready="true"]` |
| 侧栏导航 | `nav` 内 `link` 名 `主页 / 创作 / 智能体 / 画布 / 订阅`，当前项 `aria-current="page"` |
| 顶栏标题 | `.top__title` 文本 = 视图名 |
| 顶栏积分 | `.top__credits`，`aria-label="积分 n"` |
| 收起态输入条（主页） | `button.bar`，名 `描述你想创作的内容` |
| 创作面板 | `.composer[data-open="true|false"][data-tab="video|image|audio"][data-mode="text_to_video|image_to_video|text_to_image|audio"]`（`data-mode` 报后端模式名，放首帧后由 `text_to_video` 变 `image_to_video`） |
| 面板标签页 | `role="tab"` 名 `视频 / 图片 / 音频` + `aria-selected` |
| 模式行 | `role="radio"` 名 `图文 / 参考 / ...` + `aria-checked`，不可用项 `aria-disabled="true"` |
| 提示词 | `textarea` `aria-label="提示词"` |
| 规格芯片 | `.composer__specs`（文本如 `720P | 16:9 | 5s`）；弹层 `.specs-pop`，内含 `button[data-res]` / `button[data-ratio]` / `button[data-dur]`，选中 `aria-pressed="true"` |
| 音频开关 | `.composer__audio[role="switch"]`，`aria-checked` |
| 模型芯片 | `.composer__model` |
| 创作按钮 | `button.composer__send` 名 `创作`，`data-busy`，含 `.composer__credits`（数字） |
| 错误行 | `.composer__error[role="alert"]` |
| 图片槽 | `.composer__slot` + `input[type=file]`（`aria-label="上传图片"`），有图 `data-state="ready"` |
| 创作页当前任务 | `.task[data-job-id][data-state="idle|busy|done|failed"][data-status]`，`.task__pct`、`.task__stage`、`.task__err`，按钮 `取消 / 重新生成`，`link` `下载` |
| 主页瀑布流卡片 | `.masonry__item[data-kind="video|image"][data-purged]`，标签页 `role="tab"` 名 `视频 / 图片 / 模板 / 挑战` + `aria-selected` |
| 创作页重试阻断 | `.task__blocked[role="alert"]`，出现时无「重新生成」按钮 |
| 作品详情浮层 | `.work[role="dialog"]`，按钮 `用这条提示词再生成`、`关闭` |
| 头像菜单 | 按钮名 `账户`，菜单内按钮 `退出` |

## 8. 派工与验证

- coder-A：壳、上下文、主页、创作面板（接真）、创作页、登录页、`globals.css`、删 `LumenHome`。
- coder-B（并行，只碰自己的文件）：`agent/ canvas/ subscription/` 三个视图 + 三个 css 文件；对外只导出默认组件，props 仅 `SubscriptionView({ credits })`。
- tester（并行）：按 §7 重写 `e2e/lumen.spec.ts` 为 `e2e/genius.spec.ts`（空态 / 视频生成到成片 / 失败重试取消 / 首帧上传 / 图片生成 / 长片分镜 / 已清理作品 / 五视图导航 / 手机端不横向溢出），并迁移 `e2e/auth.spec.ts`（其 `.app[data-ready]`、`.recent__item`、可见「退出」按钮、人民币余额文案等选择器全部失效，须改为 `.shell[data-ready]`、头像菜单里的「退出」、瀑布流、⚡积分断言，保留注册 / 鉴权 / 账号隔离 / 余额不足的业务覆盖），补 `uncertain_submit`（`retryBlocked`）场景用例。
- 门禁：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`pnpm test`、`pnpm e2e`。
- doc-writer 收尾：`DESIGN.md` 整体重写、`AGENTS.md`「前端约定」段替换、`docs/handoff.md` 加本轮小节。

### 7.1 契约细化（tester 写用例时的假设，实现须对齐）

1. 登录页根节点也带 `class="shell"` + 水合后 `data-ready="true"`。
2. `.composer__specs` 是开关：点开 `.specs-pop`，再点关闭。
3. 面板标签页（视频 / 图片 / 音频）在 `.composer` 内；主页筛选标签在 `main` 内，两组同名靠容器区分。
4. 顶栏头像按钮名「账户」，点击弹菜单（再点关闭），菜单里可见完整邮箱 + 按钮「退出」。
5. 图片页模式行渲染一个 `role="radio"` 名「默认」，`aria-checked=true`。
6. 主页空态样片占位用 `.masonry__sample`，`.masonry__item` 只给真实作品（无作品时数量为 0）。
7. 空提示词点「创作」在客户端拦截，显示 `.composer__error[role=alert]`，不发请求。
8. 创作页只有「当前任务」区是 `.task[data-job-id][data-state][data-status]`（「最近任务」用 `.recent__item`，避免同一 jobId 命中两处）；`currentJob` 是派生值，冷加载 `/create` 即以最新任务为当前任务（含本会话未提交过的），用户「关闭」后才为空。
9. `data-purged` 取 `"true"|"false"`。
10. e2e 还断言：媒体 `Cache-Control: private, no-cache`、请求体无 `model`、失败不扣积分、`.top__credits` 文本「积分 n」。
