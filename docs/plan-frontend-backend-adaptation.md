# 方案：按 Genius App 前端功能面适配后端

| 字段 | 值 |
| --- | --- |
| 状态 | v1，用户 2026-09-06 晚决策：模型用产品名不露供应商；首尾帧先接可灵（1080p）；编辑 / 续写继续置灰；礼品码提前到阶段 A；智能体 / 画布单独立项。阶段 A 已开工 |
| 日期 | 2026-09-06 晚 |
| 依据 | 在 mock 实例（`lumen-mock`，Playwright 实点）走完五个视图与创作面板的全部入口；`design_handoff/design_handoff_genius_app/README.md`；`docs/plan-ui-genius-app.md`（UI 换壳方案，把后端不支持的入口画出来置灰） |
| 原则 | 前端交付功能，供应商差异在 provider 层吸收（用户 2026-09-06）。本方案的工作就是把「置灰」逐项变成「能用」，能用的标准是至少一家已配置的 provider 支持，其余 provider 由能力路由自动跳过 |
| 基线 | `main` @ `073eff5`（YMan 接入 + 能力路由 + 余额模型）；UI 新壳在工作区（另一会话，未提交） |

## 1. 前端功能清单与后端现状

「后端」列：✅ 已有且可直接接；⚠️ 有 API 或 provider 支持但链路不通；❌ 没有。「provider」列写哪些已接入的上游能做（grok 只在配了 xAI key 时可用，生产目前没有）。

### 1.1 创作面板 · 视频页

| 入口 | 前端现状 | 后端 | provider 支持 | 要做什么 |
| --- | --- | --- | --- | --- |
| 图文（文生 / 图生） | ✅ 已接 | ✅ `text_to_video` / `image_to_video` | kling · yman · grok | 无 |
| 参考（多图参考生视频） | 置灰 | ⚠️ `reference_to_video` + `referenceUploadIds`（≤7）已存在，只有 grok 实现 | **yman**（`reference_images` ≤9）· grok；kling 2.6 无 | yman 的 r2v 路径已在 `capabilities().modes` 里声明，缺的是 UI 上传多图与 `create.ts` 对 yman 放宽 7 张上限；一天 |
| 首尾帧 | 置灰 | ⚠️ `lastUploadId` 只落盘，硬约束「尾帧永不进请求体」是为 grok 定的 | **kling 2.6**（`last_frame`，只 1080p）· yman `seedance2.5-9图`（30s）；grok 不支持 | 把「尾帧不发」从全局约束改成 **grok 专属**约束：provider `capabilities().supportsLastFrame`，kling 实现 `last_frame` 并强制 1080p（写回记录与定价）；golden test 改为「grok 永不发、kling 只在 1080p 发」；一天半 |
| 编辑（视频编辑） | 置灰 | ⚠️ `edit_video` + `sourceVideoUploadId`，只有 grok（xAI Files API） | grok；kling 1.6「多模态视频编辑」（旧版 API）；yman 无 | 生产没 grok key，暂无 provider 可用。**建议保持置灰**，等有 xAI 预算或换 provider |
| 动作模仿（角色图 + 动作视频） | 置灰 | ❌ 无 mode | **kling 2.6 / 3.0 动作控制**（`/v1/videos/motion-control` 类接口，0.5–1.2 积分/秒）；yman `reference_videos`（seedance 2.0 / minimax-h3，只收 base64 ≤64MB） | 新 mode `motion_control`：输入 = 首帧图 + 源视频；kling 走动作控制接口，yman 走 `reference_videos`；上传角色 `source_video` 已有通道（24MB 上限，够）；两天 |
| 续写 | 置灰 | ⚠️ `extend_video`，只有 grok | grok；kling 只在 1.0–1.6 旧模型有「视频延长」；yman 无 | 同「编辑」，**保持置灰** |
| 人声（音色驱动） | 置灰（设计里也是禁用） | ⚠️ `voiceIds` 字段存在，grok `referenceAudios` | kling 2.6 `voice`（音色 ID，有声 1080p）· yman `reference_audios`（base64） | 需要先有「音色库」；放第三阶段 |
| 规格：分辨率 480P / 720P / 1080P | ✅ 芯片可选 | ⚠️ 服务端对 kling / yman 用 env 固定档覆盖，用户的选择被忽略 | kling 720p/1080p；yman 720p（按 size 短边，少数模型 1080p）；grok 三档 | **改为尊重用户选择**：`resolveKlingSettings` / `resolveYmanSettings` 取 `req.resolution` 并在 provider 不支持时向上归一或 400；`capabilities().resolutions` 参与路由与芯片下发；半天 |
| 规格：画幅 | ✅ 按能力下发 | ✅ | | 无 |
| 规格：时长 4/6/8/10 + 30/45/60 | ✅ 按能力下发 | ⚠️ 芯片按第一顺位 provider，改派后可能被归一（审查 #6） | | 芯片按「当前画幅下会接单的 provider」算；半天 |
| 音频开关 | ✅ | ✅ | kling native（1080p）；yman 不可控 | 无 |
| 多镜头开关 | 仅样式 | ❌ | kling 3.0 / 3.0 Omni 多镜头；harness（30/45/60 分镜） | 短期：开关映射到 harness（打开 = 走一致性管线，时长 ≥30）；长期：kling 3.0 多镜头。**建议先隐藏或标「即将上线」** |
| 配置面板（粉点） | 仅样式，弹层为空 | ❌ | | 放负向提示词 / seed / 采样步数（yman 支持 `negative_prompt`?，kling 有 `negative_prompt`）；半天，可后置 |
| 模型芯片 | 只读文案 | ❌ 请求体无 `model` | | 设计是可选下拉。做法：`createJobBodySchema` 加可选 `model`（**必须**在服务端白名单内：`GET /api/models` 返回各 provider 已配置模型 + 能力 + 售价），路由按用户选的模型定 provider；一天半。**这是用户可见的核心功能，建议做** |
| 数量 | 固定 1 | ❌ | | 服务端支持 `count` 1–4 = 创建 N 条任务共用一个幂等前缀，余额按 N 倍预留；一天 |
| 创作搭子 | 占位浮层 | ❌ | | 需要 LLM（提示词润色）；harness 已有 director LLM 客户端可复用；放第二阶段 |
| 清空 / 收起 | ✅ 本地 | | | 无 |
| 素材选择弹窗 | 「已上传」接文件选择；「已创建」只展示不可选 | ⚠️ 上传通道有；缺「用已生成的图片当首帧」 | | `POST /api/uploads/from-job { jobId }`：把自己成功的图片任务产物复制成 `start` 上传；半天 |
| 创作按钮 ⚡n | ✅ 售价 ×100 显示 | ✅ | | 无 |

### 1.2 创作面板 · 图片页

| 入口 | 前端 | 后端 | 要做什么 |
| --- | --- | --- | --- |
| 文生图 1K / 2K + 七种画幅 | ✅ | ✅ | 无 |
| 图生图 / 参考图（设计 README 未列，但 YMan 与 ccgoai 都支持 `images/edits`） | 无入口 | ❌ | 新 mode `image_edit`（首帧图 + 提示词，走 `/v1/images/edits` multipart）；一天。**可选** |
| 模型芯片 | 只读 | ❌ | 与视频同一套 `model` 白名单 |

### 1.3 创作面板 · 音频页

人声 / 音乐 TTS：前端整页可点（子标签、语言、说话人），后端 ❌。已接入的三家里只有 **kling** 有语音合成（0.05 积分/次）与文生音效；yman / grok 无。建议：新 mode `text_to_speech`（kling）作为第三阶段；此前保持「即将上线」。

### 1.4 主页

| 入口 | 后端 | 要做什么 |
| --- | --- | --- |
| 作品瀑布流（视频 / 图片 tab） | ✅ SSR 40 条 | `GET /api/jobs?before=&limit=` 游标分页 + 「加载更多」；半天 |
| 分类芯片（广告 / 电影叙事…） | ❌ 任务没有标签 | `JobRecord.tags?: string[]`，创建时可带、作品详情可改；筛选在前端做；半天 |
| 模板 / 挑战 tab | 置灰 | ❌ | 模板 = 预置提示词 + 参数（`data/templates/*.json`，管理员维护）；挑战放第三阶段 |
| 活动横幅 | 占位图 | ❌ | 管理员可配 `data/site/banner.json`；后置 |
| 作品详情：再生成 / 下载 | ✅ | ✅ | 缺 **删除**（`DELETE /api/jobs/:id`）与 **分享链接**（签名 URL）；各半天 |

### 1.5 创作页

当前任务 + 最近 12 条：✅。缺：取消 / 重试都有；分页同主页。

### 1.6 智能体 / 画布

两者都是「LLM 编排多步生成」的产品面，本地交互已复刻，后端 ❌。它们需要：对话与任务编排服务（LLM 调用、技能定义、工具调用 = 我们的 `/api/jobs`）、会话存储、资产聚合。这是一个独立的大模块（估 2–3 周），建议作为第四阶段单独立项，本方案不展开；当前保持本地占位。

### 1.7 订阅 / 积分

| 入口 | 后端 | 要做什么 |
| --- | --- | --- |
| ⚡ 积分显示（余额 ×100） | ✅ | 无 |
| 积分使用详情 | ❌ | `GET /api/me/ledger?before=`：读 `data/ledger/<user>.jsonl` 分页；半天 |
| 账单记录 | ❌ | 同上按 `kind:"grant"` 过滤 |
| 兑换礼品码 | ❌ | 复用邀请码机制：`data/gift-codes/<code>.json { amountCny, note, usedBy }`，`POST /api/me/redeem`，管理员 CLI `mint-gift-codes`；一天。**这是无支付网关时唯一的自助充值方式，建议做** |
| 订阅方案 / 支付 | ❌ | 支付网关（微信 / 支付宝 / Stripe）；第四阶段 |
| 每日积分 / 会员积分 | ❌ | 与订阅同期 |

### 1.8 顶栏

语言切换：❌（全站中文硬编码，i18n 第四阶段）。通知：❌（可先接「任务完成」本地通知，靠 SSE 即可，半天）。账户菜单：退出 ✅；缺改密（阶段二已列）。

## 2. 后端架构上要改的三件事（先于具体功能）

1. **模型成为一等公民**：`GET /api/models` 返回 `{ id, provider, modes[], resolutions[], aspectRatios[], durations[], supportsLastFrame, supportsAudio, priceCny(样例) }`，来源是各 provider 的 catalog（yman 目录、kling 固定、grok 固定）。`createJobBodySchema` 加可选 `model`，路由改为「指定模型 → 该 provider；未指定 → 现有 ORDER 能力路由」。UI 的模型下拉、规格芯片、售价全部由这一份数据驱动，不再各处硬编码。
2. **provider 能力声明补全**：`capabilities()` 增加 `resolutions`、`supportsLastFrame`、`supportsMotionControl`、`maxReferenceImages`、`referenceVideos/Audios`；`create.ts` 的 grok 专属校验 `assertModeConstraints` 拆成通用校验 + provider `validate(req)`。
3. **硬约束改写**：AGENTS.md「尾帧只落盘，永不进入 Grok 请求体」保留字面（grok），新增「kling / yman 在声明支持时可发尾帧，且必须写回分辨率与售价」；golden test 分 provider。

## 3. 建议的实施顺序

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| **A · 面板补全**（先做，用户最直接可见） | §2 三件事 · 模型下拉 · 分辨率尊重用户 · 参考生视频（yman）· 首尾帧（kling 1080p）· 素材弹窗「已创建」可选 · 数量 1–4 | 6–7 天 |
| **B · 作品与积分闭环** | 作品分页 / 标签 / 删除 / 分享 · 积分明细与账单 API · 礼品码兑换 · 任务完成通知 · 模板（预置提示词） | 4–5 天 |
| **C · 新能力** | 动作模仿（kling 动作控制 + yman 参考视频）· 图生图 · 语音合成（kling）· 配置面板（负向提示词 / seed）· 创作搭子（LLM 润色） | 5–6 天 |
| **D · 大模块**（单独立项） | 智能体（LLM 编排 + 技能）· 画布（节点工作流）· 支付与订阅 · i18n | 数周 |

编辑 / 续写：在有 xAI key 或找到支持的 provider 前保持置灰；多镜头：先隐藏。

## 4. 需要用户拍板

1. 阶段 A 的范围是否认可；「模型下拉」是否要允许用户直接选上游模型名（如 `minimax-H3 文字`），还是只显示我们起的产品名（如「快速 · 无声」「高清 · 有声」）并在服务端映射？**建议后者**：产品名 + 售价，供应商名不露出。
2. 首尾帧只能 1080p（kling 硬约束，¥6 起）：接受，还是等 yman 的 seedance2.5（30 秒 ¥3.5）？建议先 kling。
3. 编辑 / 续写：保持置灰，还是配一把 xAI key 让它们可用（$0.08/秒）？
4. 礼品码作为当前唯一自助充值方式，是否现在做？
5. 智能体 / 画布 是否按 D 单独立项，本轮不动？
