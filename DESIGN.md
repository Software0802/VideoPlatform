---
name: Genius
description: 侧栏 + 五视图 + 悬浮创作面板的深色 App 壳；五视图均接真后端——主页瀑布流真实作品，创作面板/页真实任务，智能体真实会话，画布持久化文档与整图 DAG 运行，订阅真实购买。
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
glow:
  peak: ".40"
  rest: ".14"
  period: "6s（呼吸增量层）/ 10s（常亮底光漂移层）"
wait:
  hue-model: "124 196 255（冷光，等模型）"
  hue-approval: "240 217 168（琥珀，等人工审批）"
  period: "2.4s"
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

1. **主页 `/`**：活动横幅（`button.home__banner`：运营标了 `challenge` 的模板存在时显示它的封面与名字、点进「挑战」页签；一条都没有时是「开始创作」，点了展开创作面板——它一直是个会做事的按钮，不是装饰图）→ 标签页 视频 / 图片 / 模板 / 挑战（模板与挑战同读 `GET /api/templates`，挑战只列 `challenge:true` 的那几条，没有时显示「当前没有进行中的挑战」）→ 分类芯片（仅样式）→ 瀑布流 `columns:220px 5` 展示用户真实作品（`jobs` 中 `status==="succeeded"`，按 `output.kind` 分视频/图片），卡片标题胶囊 + hover 上浮，点击开详情浮层（播放器/图片 + 元信息 +「用这条提示词再生成」+「下载」）；`artifactsPurgedAt` 非空显示「作品已过期清理」占位卡；未清理但 `artifactsExpireAt` 剩 ≤7 天的卡片加 `.masonry__expiring` 角标（积分金），详情浮层常驻一行 `.work__expire` 写明保留到哪天、还剩几天、到期前请下载（倒计时只在挂载后算，首屏 SSR 不渲染）；无作品用样片占位并提示「还没有作品」。底部收起态输入条点击展开创作面板。
2. **创作页 `/create`**：上部「当前任务」区（阶段行 / 百分比 / 分镜 n/m / 成片 / 失败原因 / 取消 / 重新生成；`retryBlocked` 非空时显示阻断说明并隐藏「重新生成」；`artifactsPurgedAt` 非空同样禁止重试）+ 下方「最近任务」列表；创作面板默认展开。内容块底部留白 236px（`main` 本身不留，避免主页等其它视图也被顶开）。
3. **智能体 `/agent`**（见 `docs/design.md` §2h）：首屏渐变标题 + 输入卡 + 技能卡片网格（20 个技能来自 `GET /api/agent/skills`），首页与会话输入行共用 `AgentPickers` 四枚芯片：对话模型（弹层内分「对话模型」与只调发散度/篇幅的「创意档」）、图片产品、视频产品、技能；切换只影响下一轮。技能广场开关是账号级偏好（`PATCH /api/agent/skills`，多设备一致），历史抽屉读真实会话并可展开「已归档」。会话页每条待批 action 用 `.agent-chat__proposal-product` 标明实际产品与报价，助手用 `.agent-chat__meta[data-model]` 落款实际模型和创意档；右侧资产栏跟进任务并可预览。服务端没配对话 provider/白名单时整个视图置灰显示「智能体暂未开放」。
4. **画布 `/canvas`**（2026-09-11/12 起接真数据，见 `docs/design.md` §2j）：空态 → 900×620 作者坐标场景层（`fit×zoom` 缩放）→ 右键建四类节点（文本/素材/文生图/生成视频）、拖拽定位、文本与提示词防抖 600ms 落盘（`PATCH` 带 `expectedRevision`，409 保留本地并弹二选一，不静默覆盖）；素材节点保存独立 `assetId`，明示 30 天期限、刷新可预览，过期/缺失显示重新上传。左侧 `.canvas-tools` 工具栏（`FIT_PAD_X=108` 本来就给它留着位）两枚按钮都接真行为：「添加节点」开右键那份菜单，「工具箱」开 `.canvas-toolbox` 抽屉——抽屉两个页签是真数据（模板读 `GET /api/templates`、我的作品读 `GET /api/jobs` 里成功作品的提示词去重），搜索与图像/视频分类是本地过滤，「应用到画布」新建一个对应类型的生成节点并填好提示词。生成节点标签条下多一枚 `.canvas-model` 芯片（`GET /api/models` 按节点类型收窄，弹层 `.canvas-modelpop` 往下开、不被正文的 `overflow:hidden` 裁掉），选中写进 `node.product`——报价与运行早就认这个字段，只是此前没有界面能写它；「自动」= 不点名，交回服务端按能力路由。左下 `.canvas-bottom` 是缩放条（滑杆 0.5–2 叠在 fit 之上，「适应画布」拨回 1，右侧读数是最终倍率）。窄屏（≤560px）这两条都不渲染。空画布的提示里另给两枚 `.canvas-entry` 直接建「文本 / 生成视频」节点——右键不是所有设备都有。窄屏（≤560px）不按 fit 缩小场景层（375 下会缩到 0.23、节点小到不可点），固定 1:1 靠 `.canvas-scroll` 滚动平移，左侧不给未渲染的工具箱留位，`.canvas-topright__btn` 铺成整行 40px；建节点除右键外支持长按 500ms（开菜单后 400ms 内不接受点击），节点拖拽走 `pointerdown` + `pointercancel`、手柄 `touch-action:none`，`@media (hover:none)` 下删除钮常显并加大热区。顶栏「运行整图」→ `.canvas-quote` 报价弹层（逐节点价 + 复用行「重跑」勾选 + 可执行行「执行前需我批准」勾选——生成视频节点默认勾 + 合计 + 次要动作「导出工作流」，把这次要跑的步骤与人审门存成 `<canvasId>.workflow.json`，只读不建 run）→ 确认建 run；节点徽标 `.canvas-node__exec[data-exec]` 显示执行态（待批准/已复用/已跳过等），`awaiting_approval` 节点带「批准/驳回」按钮，产物以真实 `<img>` / `<video controls>` 展示；3s 轮询 run，运行中可「取消运行」。
5. **订阅 `/subscription`**（2026-09-07 凌晨起接真数据，见 `docs/design.md` §2i）：我的方案卡显示当前档位/到期日/会员积分/今日已发日积分/已购余额，兑换礼品码与流水抽屉；四档卡片是真实人民币价格（`costRatio` 成本 ÷ (1−15%毛利率) 推得，非占位值），年/月切换，「订阅」按钮真的调用 `POST /api/subscription` 从已购余额扣款，成功后刷新顶栏并 toast，余额不足提示「余额不足，请先兑换礼品码」。

### 管理页 `/admin/relays`（N3.5，2026-09-13 落地）

不进侧栏五视图：入口在头像菜单，只对 `caps.isAdmin`（`LUMEN_ADMIN_USER_ID` 点名）露出；页面服务端 `notFound()` 非管理员（与 `/api/admin/*` 404 同口径）。结构：`section.relay-card[data-card="head"|"create"|"list"]`，列表按 `priority` 升序，每行 `.relay-row[data-relay-id][data-managed][data-enabled]` 显示来源、baseUrl、keyEnv/hasKey、通道、健康、目录来源与快照时间。动作包括 enabled、排序、discover、probe 与删除，只对文件条目开放；legacy 条目提供「转为可管理条目」。每行可展开 `.relay-models[data-relay-id]`，内部 `.relay-models__row[data-model-id][data-listed]` 编辑 kind、展示名、hidden、视频/图片售价、参考图数和时长档，状态徽标显示已上架/未定价/已隐藏/默认表已含，保存只提交改过的模型。样式在 `styles/admin.css`；1253px 桌面状态列完整可见，375px 仅 `.relay-models__scroll` 横向滚动、页面本身不溢出。

## 语言切换（2026-09-07 凌晨新增）

顶栏与登录页新增 `LanguageSwitch.tsx`（disclosure），可在 `zh-CN`/`en` 间切换并写 Cookie `lumen_locale`；全站文案（除服务端错误文案）经 `useT()` 取自 `src/lib/i18n/messages/`，`data-*` 状态值不受语言影响。方案与命名空间划分见 `docs/design.md` §13、`AGENTS.md`「前端约定」。

## 颜色 / 令牌

见文首 front matter；细节按交接包 §1：正文 `#fff`，次要 `#c9c9ce`/`#a9aab0`，弱色 `#7d7e84`，占位 `#6f7075`，禁用 `#4f5056`；主强调渐变只用于主按钮/发送钮/开关轨道/活动徽标；积分色 `#f0d9a8`；订阅粉 `#ff8fb0`；导航高亮图标转主题色（默认 `#ff8a3d`）。画布底 `#0e0e10` + 点阵 `radial-gradient(rgba(255,255,255,.075) 1px, transparent 1px)`。

## 字体 / 字号

Manrope + Noto Sans SC 回退（400/500/600/700），`-webkit-font-smoothing:antialiased`，经 `next/font/google` 自托管（沿用旧配置）。视图标题 14/600；区块标题 14–15/600-700；正文 13–14；芯片 12–12.5；元信息 11–11.5；智能体大标题 `clamp(26px,3.4vw,44px)`/600；画布节点正文 11、标签 13。

## 圆角 / 高度 / 阴影 / 动效

圆角：面板 14–16、卡片 12、芯片/按钮 8–9、缩略 12、圆钮 50%。高度：顶栏 56、导航项 40、主芯片 30、面板内小芯片 28、主按钮 30（面板内）/40–42（订阅卡）。阴影：悬浮面板 `0 20px 56px rgba(0,0,0,.65)`；卡片仅 inset 描边，无外阴影。动效：过渡 `.16s ease`（颜色/背景）、`.2s`（变换）；进场 `fade-up .35s`、`pop-in .2–.3s cubic-bezier(.22,1,.36,1)`、抽屉 `slide-in .28s`；`prefers-reduced-motion` 时长归零。

**背景呼吸灯**：`.shell`（`src/app/styles/shell.css`，登录页根节点、`.share`、`.canvas-view` 各有一份同款）用 `position:relative; isolation:isolate` 建层叠上下文，叠两个 `position:fixed; z-index:-1` 的伪元素——`::after` 是常亮底光（alpha=`--glow-rest`，`glow-drift` 只漂移，周期 `--glow-period-alt`=10s），`::before` 是呼吸增量（alpha=peak−rest，`glow-breathe` 令 opacity 0→1→0，周期 `--glow-period`=6s），叠加峰值恰为 `--glow-peak`；两层相位错开读起来才像呼吸而非闪烁。`fixed` 而非 `absolute` 是因为 `.auth`/`.share` 会滚动，要盖住整个视口。`.canvas-view` 底色不透明、壳的呼吸灯照不进来，所以自带一份（伪元素是 `absolute` 而非 `fixed`）：点阵原为 `background-image`，现挪到 `::after`（`background-size:inherit` 继承宿主按 `scale` 算的点距），`::before` 只放 `--glow-rest` 的常亮底光走 `glow-drift`，没有呼吸增量层；靠 DOM 序保证点阵盖在呼吸色之上。硬约束不变：`.shell`/`.col`/`.top`/`.main` 上不做 transform（会改掉 `.pwd` 等 fixed 弹层的包含块）。

**等待特效**：所有「等模型输出」的元素用统一的冷光语汇（`--wait-hue-model`=`124 196 255`），等人工审批用琥珀暖光（`--wait-hue-approval`=`240 217 168`），周期 `--wait-period`=2.4s；共享 keyframes（`globals.css`）：`wait-pulse`、`wait-breathe`、`wait-shimmer`、`wait-flow`、`wait-dot`、`wait-ripple`，都在装饰性伪元素/子节点上，不影响 `textContent`。落点：创作页 `.task[data-state="busy"]` 顶边流光细线+描边冷光，内部渲染 `.task__wait[aria-hidden="true"][data-pct]`（`.task` 是 `aria-live`，故等待层本身无文本），有分镜时 `.task__wait-shots > i[data-done]`；创作面板 `.composer__send[data-busy="true"]`、`.composer__slot[data-state="busy"]`、`.composer__ref[data-state="busy"]` 骨架扫光+冷光描边；智能体 `.agent-chat__answer[data-thinking="true"]` 冷光呼吸描边+三个 `.agent-chat__dot`，`.agent-chat__job[data-active="true"]` 任务卡下沿流光，`.agent-chat__send`/`AgentAsk` 发送钮 `[data-busy="true"]` 轻呼吸；画布节点根 `.canvas-node[data-wait="model"|"approval"]`（判据见 `NodeCard.tsx` 导出的 `waitStateOf()`：exec 为 `ready`/`running` 或本地 running 或 job 非终态 → `model`，`awaiting_approval` → `approval`）——`model` 双圈波纹+描边流光，`approval` 琥珀慢呼吸无波纹；`.canvas-wires path[data-wait="model"]` 流动虚线；`.canvas-view[data-running="true"]` 底光提亮+「取消运行」钮呼吸与流光细线。`prefers-reduced-motion` 归零动画后，所有 keyframes 基础样式即静止态（0%/100% 为静止，50% 为峰值），背景只剩 `--glow-rest` 的静止淡光。

## 状态映射

客户端唯一状态所有者是 `src/components/genius/ShellContext.tsx`（`ShellProvider`/`useShell`），主页与创作页共用同一个 Provider 实例。关键字段：

- 能力与账号：`caps`（`mock/harness/videoDurations/videoAspectRatios/imageAspectRatios/videoModel/imageModel/audioAvailable/initialEmail/isAdmin/initialJobs`，由 `(shell)/layout.tsx` 服务端下发；`isAdmin` 只决定「中转管理」入口露不露，权限判定仍在服务端）、`me`（`GET /api/me`）、`credits`（`Math.round(availableCny*100)`，¥1=100 积分仅显示，余额模型与后端计费不变）。
- 任务：`jobs`、`currentJob`（派生值 = 显式选中的那条 ?? 最新一条，`setCurrentJob(null)` 才真正清空，方案 §7.1 #8）、`busy`/`working`、`cancel`/`retry`。
- 面板：`open/tab(video|image|audio)/mode(VIDEO_MODES 之一)/collapsed/pop(null|specs|model|count|buddy|picker|template)/prompt/res/imageRes/ratio/ratios/dur/durs/audio/multi/image(Frame:首帧上传)/nativeMode(text_to_video|image_to_video|text_to_image)/price/sendCredits/balanceShort/quotaExhausted/error/notice`。`multi` 是**派生值**（当前时长在不在 30/45/60 长片档），开关点一下就在长片档与常规档之间切时长——它不是请求体字段，`createJobBodySchema` 里也没有它。「创作搭子」（`.buddy`）不再是占位浮层：输入框带着面板里的提示词过来，发送把这句话交给真的智能体接着聊——提示词经 sessionStorage 草稿（`agent/draft.ts`）交接、跳 `/agent` 后取一次就清，不进地址栏与访问日志。
- 提交：`submit()` 走 `createJobBodySchema`（strict）；2026-09-06 夜阶段 A 起可带可选 `model`（选中产品的 id，见下「模型下拉」），未选则不传字段、沿用能力路由。幂等 key 一次逻辑创作一个（`idempotencyKey.current ??= newIdempotencyKey()`，提交成功清空，任何面板改动作废）；数量 1–4 时循环创建 N 次、各自一个幂等 key（串行提交，非批量并发）。

## 阶段 A 新增规格（2026-09-06 夜，方案 `docs/plan-frontend-backend-adaptation.md`）

- **模型下拉**（`ModelPop.tsx`）：`.composer__model` 是可点击列表（`role="listbox"`），来自 `GET /api/models`。R2.3 起**按供应商分组**：组头 `.model-pop__group-title` 显示 `providerName`（组顺序 = DTO 首次出现顺序，客户端不排序），组内每项显示图标、产品名、⚡基准积分、`costHint` 三档徽标（`.model-pop__cost[data-cost]`，颜色+文案双编码）、次要信息行（`upstreamModel` 仅在与产品名不同时显示、时长档 `5s · 10s`、分辨率档、`maxReferenceImages>0` 时的参考图数）与描述；时长档沿用面板判据（`caps.harness && supportsLongForm` 才含 30/45/60）。产品 id 用于 `data-product-id` 与提交体 model。列表获取失败退回只读文案。
- **规格芯片按产品收窄**：`SpecsPop.tsx` 三块卡（分辨率/宽高比/时长）的可选项全部来自当前选中产品的能力（`resolutions`/`aspectRatios`/`durations`），不再是全局服务端枚举；未选具体产品（走默认路由）时回落原来的服务端下发枚举。首尾帧模式下不显示宽高比卡——成片比例跟着两张帧走，选了也没处发。
- **参考模式多图**：参考图槽位从固定单图改为最多 `产品.maxReferenceImages` 张（YMan 产品 9 张、Grok 产品 7 张——参考生视频 `reference_to_video` 由声明该模式的 provider 承接，当前是 yman / grok），超过产品上限的槽位不渲染。
- **首尾帧双槽**：i2v 模式下除首帧槽外新增尾帧槽，只有当前产品 `supportsLastFrame` 为真时才显示（目前只有可灵「标准」「高清有声」两档），选中尾帧槽会自动把产品切到支持首尾帧的那个、并把分辨率锁定 1080p（上游硬约束，见 `docs/design.md` §2c）。
- **数量**：`.composer` 内新增数量选择器（芯片式，1/2/3/4），点击「创作」按选中的 N 循环调用 `createJob`，每次用独立幂等 key；卡片/进度区各自独立展示 N 条任务。
- **素材弹窗「已创建」可选**：`AssetPicker.tsx` 弹窗现在服务于「当前槽位」（首帧/尾帧/参考），标题随槽位变化；「已创建」页签点选一张成功的图片作品会调 `POST /api/uploads/from-job` 认领成上传并填入当前槽位，不再是「仅展示、标即将上线」。
- **订阅页兑换礼品码与积分流水**：「我的方案」卡新增礼品码输入框 + 兑换按钮（`POST /api/me/redeem`，成功后刷新顶栏积分并 toast 到账金额，404/409/429 分别显示对应中文错误）；「积分使用详情」「账单记录」两个链接改为打开一个抽屉，分页读 `GET /api/me/ledger`（后者带 `kind=grant` 只看充值/兑换），列表按时间倒序展示 `kind` 中文标签、金额、余额快照与备注。四档订阅卡是真实人民币价格与真实购买路径，见上「五个视图」第 5 点与 `docs/design.md` §2i。

## 与交接包的有意偏离

- 规格弹层无「预览模式」开关与「剩余试用」文案（后端没有配额档位这个概念）；分辨率/宽高比/时长只列当前产品（或无产品时服务端）下发的枚举，不画交接包里的 21:9、360P/540P 等占位档。
- `.composer__specs` 用 `font-size:0` 的分隔 `span` 保证 `textContent` 精确等于 `720P | 16:9 | 5s`（e2e 依赖精确字符串）。
- 创作页内容块底部留白 236px，`main` 本身不留（避免其它视图也被顶开）。
- 图片页图片槽置灰（后端图片路径不支持首帧）。
- 创作面板关闭态仍留在 DOM（`hidden` + `data-open="false"`），不是条件渲染，便于状态保留与 e2e 断言。
- 窄屏（≤900px）侧栏收成 56px 图标栏，导航文字用 `clip-path` 隐藏而非 `display:none`；移动端回归（`e2e/mobile.spec.ts`，375/390/768 三档）另修过：≤560px 规格弹层与画布报价层改为左右贴边全宽、智能体两列改单列横滑、≤400px 隐藏顶栏装饰性小头像；对话框类弹层统一支持 Esc 收层；画布在这一档改为 1:1 + 平移（见上）。
- 头像菜单是 disclosure 语义（按钮+条件渲染的菜单容器），不是 `role="menu"`/`role="menuitem"`。
- 进入技能广场 / 会话页（智能体视图的子状态）时顶栏标题仍固定显示「智能体」；画布视图顶栏标题固定「画布」——顶栏标题只跟五视图路由走，不感知视图内部 state（未做「视图内子页上报标题」的接口）。
- 右键菜单的节点类型名与节点标签走 `t("canvas.kind.*")`，中文态显示中文（非原型的英文占位）。
- 画布视图沿用原型的本地交互细节：工具箱搜索与分类是本地过滤；右键（触屏长按）弹出节点类型菜单。原型里的富文本条、骨架屏、结果卡、播放进度条与写死的模型列表没有对应实现，对应的 TSX/CSS/字典条目已删——画布产物一直是真实 `<img>` / `<video controls>`。
- 图片槽置灰、`edit` / `extend` / `motion` 三个模式置灰都保留，但**不再说「即将上线」**：`modeReason()` 给的是具体理由（当前产品不支持 / 平台没开这条路），`title` 与 toast 用同一句。
- 中转管理页的排序用「上移/下移」按钮交换相邻 `priority`（两次 PATCH），不用计划书 §4b 的拖动排序——移动端与可访问性优先（键盘可达、无 pointer 捕获复杂性）。
- 模型下拉按供应商分组并显示 `providerName` / `upstreamModel` / `costHint`（R2.3 起），不再沿用「只显示产品名」——DTO 白名单本就下发这三个字段，敏感面在接口不在弹层。

## 可访问性契约（DOM，e2e 依赖）

所有 `role="dialog"` / `role="alertdialog"` 的层都挂 `useDialogFocus(ref, open, initial?)`
（`src/components/genius/useDialogFocus.ts`）：打开聚焦层内第一个可聚焦元素（或 `initial`
指定的那个）、Tab / Shift+Tab 在层内循环、关掉把焦点还给打开它的元素。收层（Esc、点外层）
是另一回事，由各处的 `useDismiss` 管；画布冲突层刻意两者都不要，只能显式二选一。

| 元素 | 选择器 / 可访问名 |
| --- | --- |
| 壳水合完成 | `.shell[data-ready="true"]`（登录页根节点也是 `.shell`） |
| 侧栏导航 | `nav` 内 `link` 名 `主页/创作/智能体/画布/订阅`，当前项 `aria-current="page"` |
| 顶栏标题 | `.top__title` 文本 = 视图名 |
| 顶栏积分 | `.top__credits`，`aria-label="积分 n"` |
| 收起态输入条（主页） | `button.bar`，名 `描述你想创作的内容` |
| 创作面板 | `.composer[data-open][data-tab][data-mode]`（`data-mode` 报后端模式名，放首帧后 `text_to_video`→`image_to_video`） |
| 面板标签页 | `role="tab"` 名 `视频/图片/音频` + `aria-selected`；音频页渲染 `.composer__audio-page`（能出声的产品列表 + 说明），`.composer__opts` 整行 `hidden`——这一页没有提交路径 |
| 模式行 | `role="radio"` 名 `图文/参考/...` + `aria-checked`，不可用项 `aria-disabled="true"` 且 `title` 是具体理由；`模板` 不在单选组里，是 `.composer__mode--tpl` 按钮（`aria-haspopup="dialog"`）开 `.tpl-pop` |
| 提示词 | `textarea` `aria-label="提示词"`，计数器 `#composer-prompt-count`（`.composer__count[data-warn]`，由 `aria-describedby` 指向） |
| 规格芯片/弹层 | `.composer__specs` 文本如 `720P \| 16:9 \| 5s`；`.specs-pop` 内 `button[data-res]/[data-ratio]/[data-dur]`，选中 `aria-pressed="true"` |
| 音频开关 | `.composer__audio[role="switch"]`，`aria-checked` |
| 模型芯片 | `.composer__model` |
| 智能体选择器 | `.agent-pickers` 四个 `.agent-chip`；模型项 `.agent-pop__item[data-chat-model]`，创意档 `.agent-pop__plain[data-tier]` |
| 智能体提案与落款 | `.agent-chat__proposal-product` 显示实际产品；`.agent-chat__meta[data-model]` 显示模型与创意档 |
| 顶栏铃铛 | 按钮名 `通知`（有未读时 `.top__dot[data-count]`）；面板 `.notify` 内 `.notify__item[data-kind="job\|run\|agent"][data-status][data-ok]`，job 项另带 `data-job-id`；点击 job → `/create`、run → `/canvas`、agent → `/agent?session=<id>` |
| 智能体历史抽屉 | `.agent-drawer__row[data-session-id]`；`.agent-history__archived-toggle`（`aria-expanded`）展开已归档会话，条目 `data-archived="true"`，空态 `.agent-drawer__empty`；删除先出 `.agent-drawer__confirm[role="alertdialog"]`（对话顶栏同理 `.agent-chat__confirm`） |
| 中转模型表 | `.relay-models[data-relay-id]`、`.relay-models__row[data-model-id][data-listed]` |
| 创作按钮 | `button.composer__send` 名 `创作`，`data-busy`，含 `.composer__credits` |
| 错误行 | `.composer__error[role="alert"]` |
| 轻提示 | `.toasts[role="status"]` 里叠 `.toast`（最多 3 条），文本在 `.toast__text`；超一行的那条另有 `.toast__x`（名 `关闭提示`） |
| 图片槽 | `.composer__slot` + `input[type=file]`（`aria-label="上传图片"`），有图 `data-state="ready"` |
| 创作页当前任务 | `.task[data-job-id][data-state][data-status]`，`.task__pct/.task__stage/.task__err`，按钮 `取消/重新生成`，`link` `下载`；`data-state="busy"` 时内部另渲染等待层 `.task__wait[aria-hidden="true"][data-pct]`（不带文本，终态不渲染） |
| 重试阻断 | `.task__blocked[role="alert"]`，出现时无「重新生成」按钮 |
| 重试涨价确认 | 服务端 409 `retry_price_changed` 后，重试按钮名变为 `确认重试（¥x）`；再点一次才带上确认价提交 |
| 主页瀑布流卡片 | `.masonry__item[data-kind="video|image"][data-purged]`；封面 `img.masonry__cover[loading="lazy"]`；临期角标 `.masonry__expiring[data-days]`；标签页 `role="tab"` 名 `视频/图片/模板/挑战`；分类芯片 `.home__cat[data-cat]` 的 `data-cat` 是**落盘值**（中文），可见文本随语言 |
| 作品详情浮层 | `.work[role="dialog"]`，按钮 `用这条提示词再生成`、`关闭`；到期说明 `.work__expire[data-days][data-soon]` |
| 画布整图运行 | 顶栏按钮名 `运行整图`，运行中为 `取消运行` |
| 画布报价弹层 | `.canvas-quote[role="dialog"]`，行内勾选 `重跑`/`执行前需我批准`，按钮 `确认运行`/`取消` |
| 画布节点执行态 | `.canvas-node__exec[data-exec]`；`awaiting_approval` 时 `.canvas-node__approve` 按钮名 `批准`/`驳回` |
| 画布节点删除 | `.canvas-node__del`（名 `删除节点`）；节点有提示词 / 素材 / 产物时先出 `.canvas-node__confirm[role="alertdialog"]`，空节点直接删 |
| 画布左侧工具栏 | `.canvas-tools__add`（名 `添加节点`）开右键菜单；`.canvas-tools__btn`（名 `工具箱`，`aria-expanded`）开 `.canvas-toolbox` |
| 画布工具箱 | `.canvas-toolbox` 内 `.canvas-tool` 行 + 按钮 `应用到画布`；页签 `.canvas-toolbox__tab[data-tab="template|mine"]`；分类 `.canvas-toolbox__cat[data-cat]` |
| 画布节点模型 | `.canvas-model`（名 `选择模型`，`data-product-id` 为空即「自动」）开 `.canvas-modelpop`，项 `[data-product-id]` |
| 画布导出工作流 | 报价弹层内按钮 `导出工作流`，下载 `<canvasId>.workflow.json` |
| 主页活动横幅 | `button.home__banner`；有挑战时 `data-challenge=<templateId>` 且文本是挑战名，否则文本 `开始创作` |
| 画布等待态 | `.canvas-node[data-wait="model"\|"approval"]`（`NodeCard.tsx` 导出 `waitStateOf()`）；连线 `.canvas-wires path[data-wait="model"]`；运行中 `.canvas-view[data-running="true"]` |
| 头像菜单 | 按钮 `.top__avatar`，菜单内按钮 `账户`/`修改密码`/`退出` |
| 账户页 | `/account` 三卡 `.account__card`（账号/余额/安全）；「退出全部设备」为 `role="alertdialog"` 页内二次确认 |
| 订阅档位 | 已有生效订阅时其它档的 `.sub-card__cta[data-state="locked"]` 不可点（服务端不给中途换档） |
| 404 | 根 `not-found.tsx`，根节点 `.nf.shell`，双语标题与「回到主页」链接 |

完整契约与 §7.1 细化假设见 `docs/plan-ui-genius-app.md`。
