# Genius 未实装能力详细设计与实施计划

日期：2026-09-08。基线：源码 `43873a7`，现状依据 `review-2026-09-08.md` 的代码与实测证据。
状态：2026-09-09 已经 Codex 评审，VERDICT: BLOCK；五项 P1 主代理均判成立，用户随后逐项拍板实施。截至 2026-09-12：R01–R09 已全部修复（`e564ab6`/`9c63903`），A 显式 Reservation + B 智能体提案审批制 + C 画布持久化已提交（`1f3077f`），D 画布 DAG 运行两切片已实装——切片一提交 `b91df6c`（报价/sweep 执行器/持久化取消），切片二（run 级预算预留/审批门/产物复用，`docs/plan-dag-run-slice2-2026-09-12.md`）提交 `d38dc05`，已随 `04efdce` 部署生产；E–J 仍未实施。正文保留历史方案，字段、路由和阈值仍为建议契约，不冒充现有 API；实际 as-built 以 `docs/design.md` 为准。

## 1. 目标、范围与优先级

目标：一次创作有确定的输入、可解释的报价、可恢复的执行和可复用的产物；失败和重复请求不能形成额外的非预期资金变动。

暂按“小范围有账号的创作者、单实例运行”设计。没有真实 DAU、留存和成本分布，不给虚假的交付日期。下表工作量为单名熟悉项目工程师的净开发日区间，含测试与文档，不含外部开户、审批、真实媒体生成等待及不可控返工；用于比较范围，不能直接相加当日历承诺。

| 包 | 当前状态 | 本期建议 | 估算 | 放行依赖 |
| --- | --- | --- | --- | --- |
| A 资金与执行恢复 | 主路径已实现，失败边界有缺口 | 最优先修复 | 8–15 日 | 故障注入验收 |
| B Agent 轮次/提案/素材 | 文本对话和生成已实装 | 稳定轮次、草稿、提案审批、资产引用 | 5–9 日 | A 的幂等与分池退款 |
| C 画布文档与单节点 | 本地演示 | 保存/恢复 + 一个真实生成节点 | 5–8 日 | A、能力目录 |
| D DAG 工作流与人审 | 未实装 | 类型端口、运行快照、关键步骤审批 | 8–14 日 | C 单节点验收 |
| E Harness 质量开放 | 代码已实现，真实质量未验收 | 先 30s 受控验收，再 45/60 | 工程 3–6 日 + 实测 | A、真实供应商、素材与预算 |
| F 其他视频模式 | 部分后端已有，UI/生产未开放 | 按模式单独验收 | 每模式 2–4 日 | 实际 provider 可用 |
| G 支付与订阅生命周期 | 内部余额/订阅已实装，无收款网关 | 先订单，后单渠道收款 | 7–12 日 + 渠道接入 | A、经营规则确认 |
| H 移动端/语言/账号/留存 | 部分已有 | 完成真实任务闭环 | 5–9 日 | 可分小批独立交付 |
| I 运维/存储扩容 | 单机文件/本地媒体已实装 | 发布恢复、备份演练优先 | 4–7 日 | A 数据恢复协议 |
| J 挑战/技能市场/协作 | 占位或本地选择 | 暂缓外部发布 | 需求验证后估算 | 使用需求与运营责任 |

优先完成 A+B+C 的最小闭环。D/E/G 不同时开工；用户确认主营“多镜视频”后优先 E，确认主营“可复用创作流程”后优先 D。支付是否提前取决于真实收款需求。

## 2. 共同契约与不可破坏的约束

- 所有生成继续走 createJob → provider 路由 → runner，不让 Canvas/Agent 自建第二套提交、限流、定价和扣款。
- 浏览器只通过 `src/lib/client/*`；前端遵守现有 BEM、字典、Shell 状态边界，不引组件库。
- ownerId 从会话获得，文档/run/turn/素材/审批均独立鉴权，非本人 404；公开分享继续独立信任域。
- 任何减少可用资金的准入都遵守 admission → user。不得在 user 锁内反向拿 admission。
- 金额建议内部用整数分，积分仅显示换算；迁移时 round2 → 分的差异要报告，禁止静默修改历史余额。
- 幂等键绑定 owner + 操作种类 + key；保存 requestHash。相同 key 相同摘要返回原结果，异参 409；用户主动重新创作用新 key。
- 业务操作身份与账务去重分工明确：Turn/Run/Order 存执行状态和原请求，资金变更仍统一经 applyBalanceChange，以现有 ref 语义作为唯一账务去重入口。
- 读接口返回稳定 error.code、params、requestId；客户端翻译，不把上游原文或内部 provider/key 暴露给用户。

## 3. A：资金、提交与恢复中心

### 3.1 持久化选型（需要确认后实施）

| 方案 | 收益 | 代价 | 建议 |
| --- | --- | --- | --- |
| 单写进程 + 原子用户快照中的 operation 标记 + 可恢复流水导出 | 保留文件架构，改动集中 | 必须自行维护导出恢复、压缩水位和备份一致性；CLI 不能继续直接写 | 当前小规模首选修复路径 |
| 单机事务数据库承载资金/订单/幂等，媒体留文件 | 事务与唯一键、跨进程一致性更清楚 | 依赖选型、Windows/Linux验证、迁移与回滚成本 | 支付前若资金操作继续扩展，评估转用 |
| 全量 Postgres + 外部队列 | 多实例更成熟 | 运维和迁移范围远超当前故障修复 | 无多实例需求前不先上 |

首选方案的最小协议：

1. 写入操作意图，含 operationId/ref、requestHash、两池 delta、原 chargeRef、期次、预期用户 revision。
2. 在用户锁内将新余额、revision 和该 operation 的 applied 标记一起原子写入 user 事实源；相同标记不二次改变余额。
3. 幂等导出流水，再推进导出水位。导出失败返回可恢复状态，不把同一资金变动当成未发生。
4. 启动和读取资金前完成待恢复操作；检查损坏时 fail closed，不能把所有读错误当空流水。
5. applied 标记不能在重放仍有效时随意删除；按已导出水位建立持久唯一索引并验证可重建，再压缩。关键唯一凭据纳入备份。

这个协议必须做掉电/写失败验证；只写 intent 而没有与余额同原子提交的 applied 标记不足以实现幂等。若复杂度超过事务数据库迁移，应回到选型表改选，不硬撑自研日志。

### 3.2 预留与会员期次

新增 Reservation 概念：id、ownerId、sourceType/sourceId、amountMinor、memberAllocation[{subscriptionId,periodIndex,amountMinor}]、purchasedMinor、state、createdAt、settledOperationId。

任务提交时先结算当前会员期，再按会员优先分配；旧期已预留部分仅用于对应在途任务，不允许再消费。跨期后新任务使用新期积分。取消释放原预留，已过期会员部分回到过期桶并记录冲销，不转已购余额。超长期占用需任务期限和恢复中心处置，不能靠无限预留延长权益。

与现有 job 索引预留只保留一个口径：迁移后 job 引用 Reservation，禁止“任务售价求和”与显式预留同时扣减可用额度。查询仍走索引，不能恢复为扫描所有 job.json。

### 3.3 原路退款与订阅订单

- charge 保存 member/purchased 实际分配，refund 引用 chargeId，累计退款不得超过原金额；过期部分明确标作权益退回后到期，不变成已购金额。
- SubscriptionOrder：id、ownerId、keyHash、requestHash、planId、cycle、priceMinor、creditsPolicyVersion、startedAt、status、chargeRef、subscriptionId。已支付未履约直接恢复，不再判首次余额。
- 周期沿用 30 天、12 期=360 天；界面直接显示期限。是否改自然月/年另作产品决策，不能在本批隐式改存量用户到期日。
- quote 保存成交快照与 expiresAt；购买时已过期返回 quote_expired，不能静默按新价收费。

### 3.4 Provider 提交状态与恢复 API

建议在 Job/Shot 增加 executionPhase 和 submitOutcome，而非将每种故障都塞入 failed：

`prepared → submitting → accepted(remoteId) → polling → downloading → settling → completed`

分支：`submitting → submission_unknown`；`downloading → download_pending`；`settling → settlement_pending`。明确拒绝可失败，unknown 必须查单或人工核验。执行完成与账务待处理分别表达，但账务未落地不能丢预留。

建议 API：`GET /api/jobs/:id/recovery` 返回允许的动作和原因；`POST /api/jobs/:id/reconcile` 查原单；`POST /api/jobs/:id/resume` 继续 poll/download/settle。每个动作幂等且验证当前阶段；管理员核验写 actor、证据引用、时间与结论。没有查单能力时不伪造自动恢复按钮。

恢复中心放创作页任务详情及管理员视图，展示“结果待核验/成片下载待恢复/结算待处理”，用户不需要理解 remoteId。取消停止后续步骤；不得宣称取消一定撤销上游费用。

### 3.5 A 验收矩阵

| 场景 | 必须成立 |
| --- | --- |
| 每个资金写入点失败/重启 | 同 operation 只变更一次，两池和流水可恢复 |
| 任务、订阅、对话并发 | 资金不能重复承诺；锁序无死锁 |
| 年付跨期、不先读取账户 | 旧期不能新消费，原预留可正确结算 |
| 提交受理但回包丢失 | 不自动创建第二个上游任务 |
| 已有 remoteId 后轮询/下载失败 | 恢复原任务，不购买新生成 |
| body 停滞/取消 | 应用期限生效，并发槽最终释放 |
| 用户/任务/映射任一落盘中断 | owner 隔离、幂等映射可重建 |

## 4. B：Agent 从一次 HTTP 调用变为可恢复轮次

### 4.1 模型与 API

Turn：id、clientTurnId、ownerId、sessionId、requestHash、locale、inputText、assetRefs、configSnapshot、status、reply、proposals、actionResults、chargeRef、refundRef、errorCode、createdAt/updatedAt。

状态：`accepted → thinking → proposed → awaiting_approval → executing → succeeded/partial_failed`；模型失败为 failed/refund_pending；结果未知保持可查询，不自动开始新轮。

`POST /api/agent/sessions/:id/messages` 必带 clientTurnId，返回 202 + turnId；`GET /api/agent/sessions/:id/turns/:turnId` 查询。新增 `POST .../turns/:turnId/approve` 绑定 proposalRevision、quoteId、requestHash。现有同步客户端可过渡轮询直到完成。

### 4.2 交互与费用

- 首次发送展示对话费；生成提案展示独立生成费、最终 prompt、产品、规格和输入预览。默认用户批准后创建 Job。
- 可选择“本会话预算内自动执行”，服务端保存预算、截止时间和允许动作；预算内也不能执行 schema/权限不合法的动作。默认值为关闭。
- 失败消息保留在消息流，可编辑重试；网络未知时先查原轮次。打开历史同步 skill/tier/products；每轮保存快照，旧轮不会被新配置改写。
- locale 驱动回复语言，错误 code 驱动 UI 文案，避免英语界面强制中文回复。

### 4.3 资产和技能

AssetRef 只接受本人 jobId+outputId 或已认领 uploadId；解析时验证存在、未清理、类型匹配。LLM 只接收本轮必要资产和状态摘要。只开放真实支持的 t2i/t2v/i2v；没有图像编辑能力时，明确是重新生成而非保主体精修。

SkillManifest 增加 version、supportedActions、requiredInputs、capabilityRequirements、exampleOutput；服务端按能力过滤技能，不让文案承诺工具无法执行的 15 秒/精修等能力。初版是受控内置技能，不开放用户任意脚本或外部 SKILL.md 执行。

**验收**：断网不重复扣费；刷新恢复 thinking/proposed 状态；异参重放 409；修改提案使原批准失效；已清理/他人素材不可引用；中英文可走完整闭环；删除会话不静默取消独立生成任务。

## 5. C/D：画布、图执行与人审

### 5.1 文档与运行分离

CanvasDocument：id、ownerId、schemaVersion、revision、title、viewport、nodes、edges、createdAt/updatedAt。
Node：id、type、position、config、inputPorts/outputPorts；Port 类型为 text/image/video。素材存引用，不存任意远程 URL、Base64 大文件或密钥。

第一阶段节点：文本、已有素材、文生图、文生视频、图生视频、预览。初版建议上限 50 节点/100 边（容量假设，需压测后调整），不支持环、不支持任意 JS、多人实时协作和开放插件。

API：`GET/POST /api/canvases`，`GET/PATCH /api/canvases/:id`；PATCH 带 expectedRevision，409 时提示保留本地副本并比较，禁止最后写覆盖。保存 debounce 800ms 为初始建议；失焦立即 flush，离页保存失败需可见。删除用软删除，并禁止删除活跃运行引用的文档快照。

### 5.2 单节点先交付

用户新建文档 → 填 prompt/产品 → 保存成功 → 报价 → 执行 → Job 进度 → 结果节点显示真实产物 → 刷新恢复 → 作品库可找到该 Job。单节点闭环通过后才接 DAG；示例画布和真实文档入口清晰区分。

### 5.3 WorkflowRun

Run：id、ownerId、documentId、documentRevision、graphSnapshot、inputSnapshot、quoteId、approvedHash、budgetMinor、nodeExecutions、status。
NodeExecution：nodeId、attempt、inputHash、status、jobId、outputRefs、errorCode、startedAt/finishedAt。

运行先做类型、环、容量、素材 owner、provider 能力校验；失败不产生付费提交。冻结 documentRevision，用户继续编辑不影响已运行快照。

节点状态：waiting_dependencies → ready → running → succeeded/failed/unknown/blocked。下游只接收成功且完整的输出。Run 支持 partially_failed，保留成功分支。

创建 Job 的 key 为 `run:<runId>:<nodeId>:<attempt>`。attempt 只有明确重新生成且重新批准时递增；恢复原任务不变 key。输入修改使节点及其下游 stale，上游不变则可复用；引用产物已清理则 blocked，不能悄悄重生成。

### 5.4 预算与审批

`POST /api/canvases/:id/quotes` 返回节点明细、总价/上限、quoteId、expiresAt、参数摘要。
`POST /api/canvas-runs` 使用文档 revision、quoteId、idempotencyKey；`GET /api/canvas-runs/:id` 查询；`POST /api/canvas-runs/:id/cancel` 停止后续执行；`POST /api/canvas-runs/:id/approvals` 批准检查点。

Run 上限需真正被占用：建议总预算预留在 A 的 Reservation 下，调度节点时转移给子 Job，不能 Run 与子 Job 双重预留。未消耗部分终止时释放。若一期暂不实现总预留，则只能明确承诺“逐节点检查余额、可能中途余额不足”，不能同时声称全图已预付保证完成。

Approval：id、ownerId、runId、checkpoint、revision/hash、quoteId、approvedBudget、decision、at。输入/产品/规格/执行节点集合改变、quote 过期或预算增加后必须重新批准。低成本单图一次审批；分镜/关键帧到视频这种返工昂贵节点设置中间门。

### 5.5 持久化与取消

初版建议 `data/canvases/<ownerId>/<id>.json`、`data/canvas-runs/<ownerId>/<id>.json`，目录清单为可重建索引；写后发事件，轮询仍是真相。启动恢复已接受节点，只继续等待/下载，未知提交进入恢复中心。

取消阻止未提交节点，已提交节点按现有取消政策处理；Run 结束不删除 Job。删除画布不级联删除作品；素材清理前查询活动引用，保留运行必要输入副本或阻止清理。不要把整个素材库永久保留当作解决方案。

**验收**：刷新恢复、双标签冲突、环/错误类型拒绝、他人素材 404、同 key 单次执行、审批过期失效、取消不启动下游、分支失败保留成功结果、重启不重新 submit、子 Job 与 Run 无双计费。

## 6. E：Harness 从“代码存在”到质量放行

不重写已有 orchestrator/Director/QC/stitch。先补 A 的 submit unknown 与费用恢复，再完成以下证据：

1. 补缺失两张人物素材并记录来源/使用授权；`pnpm evals:check` 全绿。
2. 验证实际 provider 支持 Director、参考图、extend/Files 及下载链；仅配视频 key 不代表所有子步骤可用。
3. 先跑原生模式与单条 30s 脱敏冒烟，留输入、计划、关键帧、成片、用量和账目；单条冒烟不能定视觉阈值。
4. 遵守现有 rubric：8 个 harnessCases、重复样本、naive_concat 对照、失败进入分母；calibration 定阈值，report 独立验。覆盖 qc_retry 与 interrupt_resume。
5. 核对当前执行硬上限（提交预估×2）和评测目标（实际/提交预估≤1.5）两口径；计入 Director/关键帧/视觉评分/镜头，不能只算成功视频。
6. 30s 达标后才对 45/60 分档验证；质量未达标则保持关闭，允许分镜人审或标明实验性范围。

花费控制：真实测试前生成报价清单，由用户确认一个批次预算；在尚无真实报价时不填拍脑袋金额。预算达到上限、出现未知提交或不可解释账差立即停止新增付费调用，转恢复/分析。真实质量、时延与可交付片成本写入 evals/runs，而非仅留下“成功生成”。

## 7. F：参考、编辑、续写与其他生成模式

| 模式 | 最小输入/交互 | 上线验收 |
| --- | --- | --- |
| reference_to_video | 多图素材、顺序、上限、角色描述；按产品能力限制 | 真实多图被上游接收；不能只验请求 shape |
| edit_video | 本人源视频、修改指令、可用产品；展示不可保留项 | 源视频 upload/Files 全链，不做 data URI 兜底 |
| extend_video | 本人源视频、续写长度、继承规格、完整报价 | 成片时长/连接效果和失败恢复真实验证 |
| 首尾帧 | 延续现有支持该能力产品的双槽 | 两端素材与强制分辨率/定价匹配，不向 Grok 发尾帧 |
| 图像编辑/音频/口型等 | 当前不承诺可执行 | 等 provider 合同能力、费用和产物测试后单独立项 |

服务端能力矩阵是唯一真相，UI 不按 key 存在性猜能力。无可用产品显示原因；不删除已有后端 mode。选择源素材时展示时长/画幅/留存期限，清理后的素材不得进执行报价。

## 8. G：支付网关与订阅生命周期

### 8.1 范围与选型前提

一期仅充值已购余额 + 沿用余额购买订阅，不做自动续费。支付渠道需根据经营主体、结算币种和用户地区选择，本设计不指定渠道或宣称已满足其准入；接入时以渠道官方文档核对签名与状态语义。

### 8.2 Order 与回调

PaymentOrder：id、ownerId、kind=topup、amountMinor、currency、channel、merchantOrderNo、providerPaymentId、status、expiresAt、requestHash、creditedRef、createdAt/paidAt。订单由服务端定价，不信任浏览器传入的到账额。

状态：created → pending → paid → credited；失败分为 canceled/expired，退款分 refund_pending/refunded。回调先验签并核对商户/订单/金额/币种/交易号，持久化唯一事件，再用 `ref:pay:<orderId>` 调统一资金入口；回调重放只返回原结果。浏览器跳回成功页不能当作到账证据。

API：`POST /api/payment-orders`（档位/幂等键）、`GET /api/payment-orders/:id`、`POST /api/payments/:channel/webhook`。webhook 是精确放行且自行验签的服务入口；不能整体放开其他 /api/payments 请求。定时对账只查询未定订单，不再发起新支付。

### 8.3 退款、余额使用与订阅政策

退款总额 ≤ 已付额。退款申请先锁定可退余额，避免提交渠道退款后余额又被消费；若已消费，进入人工处理，不自动把余额抹成负数或赠送等值会员池。渠道确认退款成功后完成账务冲销，失败释放锁定；任何重放都不再次退款。

订阅一期仍禁止活跃期间叠加购买，清晰显示到期日、每日积分是否需当日访问领取、30天重置。升级/降级/按比例退款/自动续费作为二期独立规则，未确定前不展示可操作入口。订阅价格保存成交快照，不能随 provider 成本变化重写历史权益。

**验收**：重复/乱序回调、错金额/签名、服务重启、paid 未 credited、余额已使用退款、渠道超时、旧 quote，全部沙箱覆盖；正式付费冒烟需另行授权。

## 9. H：账号、语言、移动端和数据留存

### 9.1 用户闭环

现有注册/改密/退出保留。补自助忘记密码：中性响应防账号枚举、限流、短时一次性 token（仅存 hash）、重置使旧会话失效；发信渠道未定前保留管理员重置。重置不影响资金字段，管理操作统一由应用写入服务执行。

改密、会话管理与账户资料放账户页，不把顶栏小菜单变成复杂表单。账号删除先软禁用与会话失效；资金/订单留存政策与媒体删除分开，不能为“删除账号”随意删对账证据。

### 9.2 完整 i18n

统一 error.code+params；客户端映射到所属 namespace，未知错误显示通用文案+requestId。Agent locale 传入轮次。Canvas 工具名从演示文案转字典，数据状态值仍 ASCII。金额/日期按 locale 格式化，但资金时区仍单一规则。

### 9.3 移动端

沿用设计语言；375/390/768 宽真实检查输入键盘、素材上传、弹层、进度、成片预览、下载、历史会话和订阅。画布移动端首期提供节点列表/检查器与结果查看，复杂连线是否开放由可用性测试决定。

验收不仅是“无横向溢出”：主要按钮可触达、键盘不遮发送/错误、弹层可关闭、焦点回到触发控件、长标题/英文不截掉金额、慢网重复点击不重复订单。保留 compositor 与 main 兄弟关系。

### 9.4 通知、会话与素材留存

通知若需要跨刷新保存，新增 owner 事件索引与 lastReadSequence，支持游标/补拉，SSE 仅作提醒。当前内存通知无需直接否定，新增持久通知按需落地。

会话/画布/run 设置独立留存策略；建议默认先沿用媒体30天并明确告知，最终期限待产品确认。删除会话不删除独立作品；清理 run 不能删除资金 ref。活动执行的输入引用要保护，清理后列表显示明确占位，重试先校验素材完整。

## 10. I：运维、备份、管理员与扩容

- 发布目录 `releases/<version>` + current 指针，共享 data/env；先准备并验证 Linux 原生依赖，再切换。失败回旧完整 release。Windows 构建仍不复制 Windows node_modules 到 Linux。
- 管理 CLI 改为调用仅本机可访问、经认证的应用管理入口，或明确停服后的离线维护模式；不再与线上服务并发改同一 user.json。操作保存 operator/ref/reason，不把充值当无身份的文件编辑。
- 备份选择一致性快照：短维护窗口排空写入后打包，或事务数据库支持的备份方式；不能以 tar 退出0替代一致性验证。恢复演练核对用户、礼品码、两池余额、资金唯一 ref、订单/任务执行位置及产物缺失标记。
- 元数据备份不含媒体是现有取舍，恢复后要明确标记缺失产物，不能让用户不断撞404。异地副本加密、校验、可恢复性另验证；不声称 ECS 快照已启用。
- 指标：submission_unknown 数量、settlement_pending 时长、请求重放命中、退款积压、备份年龄、恢复演练结果、队列等待、媒体下载失败率和成本不完整率。阈值按内测基线定，不预设“生产达标”。
- 对象存储：有磁盘/跨机读取需求才接 MediaStore；私有对象、短授权、公开分享单独验证，不能把永久公有 CDN URL 泄露给所有用户。
- 多实例：先让资金/幂等/会话/队列具备跨进程一致性，再选外部持久队列与 lease/fencing。仅引 BullMQ 不能保证付费 POST exactly-once，unknown 提交仍需恢复协议。

## 11. J：暂缓但不遗漏的功能

| 功能 | 先做的需求验证 | 如立项的最小设计 |
| --- | --- | --- |
| 模板管理 | 现有六种种子是否真的被复用 | Template version+schema+能力要求；管理员发布，用户回填时重新报价/校验 |
| 挑战活动 | 是否有明确运营人、规则与真实参与 | 规则版本、活动期限、用户主动投稿、展示授权、审核/撤回；不自动公开私人作品 |
| 技能市场 | 内置技能用量是否支持开放市场 | version+签名/审批+能力白名单；先声明式模板，不执行任意代码 |
| 多人画布 | 单人流程是否稳定且确有协作需求 | 角色权限、文档冲突模型、审计、资产共享授权；不直接取消 owner 校验 |
| 新供应商/即梦 | 真实能力是否补足现有短板 | 有限预算 spike、映射 golden、实际产物和成本、取消/未知提交协议 |

这些不是第一期承诺。每项须有目标用户、成功指标、依赖、预算和停止条件后再排期，避免再次上线看似可用的假入口。

## 12. 实施切片、验证与待决项

| 里程碑 | 交付证据 | 停止/降级条件 |
| --- | --- | --- |
| M0 修复资金事实 | R01–R05 故障注入回归、迁移前后两池核对 | 任一历史余额无法解释则停止迁移 |
| M1 修复执行身份 | R06–R09、unknown/恢复中心、同key同结果 | 上游无法查单则人工核验，不自动重买 |
| M2 Agent 可恢复闭环 | 提案/审批/素材引用、草稿与历史配置 | 不支持精修时只承诺重生成 |
| M3 画布单节点 | 保存、报价、真Job、刷新恢复 | 单节点不能可靠恢复则不做DAG |
| M4 按主线二选一 | DAG人审或30s质量报告 | 预算/质量不达标保持受控开放 |
| M5 收款与运营 | 支付沙箱、回调/退款对账、发布与备份演练 | 渠道/经营政策未定则继续礼品码 |

每批改代码后依次 tsc --noEmit、eslint src、pnpm test；改 UI 再 pnpm e2e。补充的是跨写入失败、并发 barrier、时间跳转、HTTP 回包丢失与重启恢复，不能只增加跟着实现写的 happy-path 测试。真实上游验收与 mock 回归分开报告。

确认后才能实施的新机制：资金持久化选型、期次预留规则、Agent 默认提案审批、画布与长片主线优先级、支付渠道与订阅权益、留存期限。其余纯修复可独立成批评审；本轮只交设计，未请求生产操作或付费验证。
