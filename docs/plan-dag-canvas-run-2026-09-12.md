# D 包切片一：画布 DAG 运行（CanvasRun）实施计划

日期：2026-09-12。基线：`main` @ `1f3077f`（A–C 已提交未部署）。
状态：**已实装，工作区未提交**（2026-09-12）。Codex 评审 `VERDICT: BLOCK`（6×P1 + 1×P2），全部判定成立并已在本稿修订（各节「修订」标注）。门禁全绿：`tsc`/`eslint`/`pnpm test`（96 文件 1120 通过，新增 `run-graph.test.ts` 13 条）/`pnpm build`/`pnpm e2e`（29 通过；顺带修复 R01/R03 起遗留的 `grant-balance.mjs --offline` setup 断点与 genius.spec 分页用例的种子时间窗脆弱点）。来源：`docs/plan-unimplemented-2026-09-08.md` §5.3–5.5，本切片是其中的「DAG 运行 + 报价 + 取消 + 恢复」，不含总预算预留与运行中审批门。

## 1. 范围

画布从「逐节点手动点运行」升级为「整张图一次运行」：校验 → 报价 → 确认 → 按依赖顺序自动执行全部生成节点 → 产物随 run 展示。

**做**：

- `CanvasRun` 持久化：`data/canvas-runs/<ownerId>/<runId>.json`，一文件一 run，含 `canvasId`、`documentRevision`、`graphSnapshot`（创建时冻结的 nodes/edges）、逐节点 `nodeExecutions`、`status`、`cancelRequestedAt`、时间戳。
- 报价：`POST /api/canvases/:id/quotes` 逐节点报价 + 总价 + `quoteHash`。**不落盘 quote 实体**——报价是（文档 revision + 归一化参数 + 价目表）的确定性函数，创建 run 时重算比对 hash，图变/价变/revision 变 → 409 `quote_stale`。
- Run 创建：`POST /api/canvas-runs`（`{canvasId, quoteHash, idempotencyKey}`），同 key 同参重放交回原 run，异参 409。
- 查询：`GET /api/canvas-runs/:id`（详情）、`GET /api/canvases/:id/runs`（该画布 run 列表，倒序）。
- 取消：`POST /api/canvas-runs/:id/cancel`——持久化 `cancelRequestedAt`，泵停起新节点、继续收敛在途子任务（走现有 job cancel 语义，R09 checkpoint 不变），全部终态后 run → `canceled`。
- 执行器：`instrumentation` 注册的周期泵（仿 `startJobRunner`）：每个非终态 run 先按 job.json 刷新节点状态（轮询是真相），再提交所有依赖已全部成功的节点。重启后泵自动续跑。
- 前端：画布「运行」按钮 → 报价弹层（逐节点明细 + 总价 +「逐节点扣费，可能中途余额不足」）→ 确认 → run 进度 + 节点执行态徽标 + 轮询。i18n `canvas` 命名空间。

**明确不做**：run 级总预算预留（一期逐节点扣费，UI 明示可能中途余额不足）、运行中人工审批门、stale/复用（改图 = 新 run，所有生成节点都重跑）、`POST .../approvals`、run 结果写回画布文档（见 §5 修订 6）。删画布不级联删任务与 run。

## 2. 数据模型

```ts
CanvasRun = {
  schemaVersion: 1, id: `crun_*`, ownerId, canvasId,
  documentRevision,
  graphSnapshot: { nodes, edges },   // 冻结图；之后编辑画布不影响本次运行
  quote: { items: [{nodeId, mode, priceCny, summary}], totalCny, hash },
  idempotency?: { key, requestHash },
  status: "running" | "succeeded" | "partially_failed" | "failed" | "canceled",
  cancelRequestedAt?: string,        // 修订5：持久化取消意图
  nodeExecutions: [{ nodeId, attempt: 1, status: "waiting_dependencies" | "ready"
    | "running" | "succeeded" | "failed" | "blocked", jobId?, errorCode?,
    startedAt?, finishedAt? }],
  createdAt, updatedAt, finishedAt?,
}
```

`unknown` 节点态不单列：子任务 `uncertain_submit` 由 job 层表达，run 把该节点标 `failed` + `errorCode:"uncertain_submit"`，恢复中心承接核验。

## 3. 校验（报价与创建共用同一函数，校验对象 = 冻结图）

- 无环（拓扑排序失败即拒）、节点 ≤50、边 ≤100；
- 生成节点必须有提示词来源（自身 prompt 或连入 text 节点）；
- material 必须有 `uploadId`，sidecar 存在且归本人（只查不消耗，修订 1）；
- **修订 4**：跨节点输入一律解析自本轮 `nodeExecutions`——上游 `gen_image` **不要求**已有 jobId（新画布首次运行正是主场景）；不引用历史任务产物；
- 至少一个可执行生成节点。

## 4. 报价口径

逐节点复用 `chooseProduct` + `providerSettingsFor` + `priceCny` 归一管线（与 `createJob` 同函数），抽「只算不建」的 `planNodeJob(graph, node)` 供报价与执行器共用。

**修订 3（执行时价校验）**：run 落盘时 `quote.items[].priceCny` 是成交快照；执行器提交节点前重算归一价，与快照不一致 → 该节点 `failed` + `errorCode:"price_changed"`、下游 `blocked`、run 终态 `partially_failed`，前端引导重新报价。价目表/产品配置中途变更不再静默按新价扣款。

## 5. 幂等、素材与崩溃恢复（修订 1、2、5、6）

- run 创建幂等键存 `CanvasRun.idempotency`（事实源）；不另建 `data/idempotency` 映射。
- 子任务幂等键 `run:<runId>:<nodeId>:<attempt>`，attempt 恒 1（重跑 = 新 run）。
- **修订 2（崩溃窗口）**：提交节点前先 `lookupIdempotency(ownerId, key)`——命中即接管既有 jobId 写回 nodeExecution，**不重新解析输入**。这关上「createJob 成功 → run 写回 jobId 之间崩溃，重跑解析出不同 uploadId 撞 409」的窗口。同一修复应用到现有 `runCanvasNode` 单节点路径（同样的窗口已存在）。
- **修订 1（素材不消耗）**：`createJob` 的 `claim()` 会 move 文件并删 sidecar，material 的 `uploadId` 是一次性的。画布路径一律**复制**：读 `data/tmp/<uploadId>` 字节 → `storeUploadFromBuffer` 出新上传 → 把新 id 传给 createJob。上游 `gen_image` 本轮产物照旧复制（现有 `resolveImageInput` 逻辑改为读 nodeExecution.jobId）。一素材连多节点、同一 run 重复执行都成立；同时修掉单节点运行消耗 material 的既有 bug。
- `queue_full` → 节点保持 ready，泵下一轮重试（15s 起步退避，不设 3 次判死——queue_full 在 run 里是等待信号）；余额不足等准入拒绝 → `failed` + 下游 `blocked`。
- **修订 5（取消）**：`cancelRequestedAt` 落盘后，泵不再提交新节点；在途节点继续按 job 状态收敛（已提交的 job 由现有 `/api/jobs/:id/cancel` 语义处理，run cancel 会逐个调它）；全部终态后 run → `canceled`。崩溃重启后泵读到 cancelRequestedAt 继续收敛，不误提交。
- **修订 6（不写回文档）**：run 执行**不**把 jobId 写回画布节点——后台写会与用户编辑抢 revision（`patchCanvas` 409 → 前端整篇替换会吃掉防抖窗口内的输入）。节点产物展示改为「该画布最新 run 的 nodeExecutions」overlay；`node.jobId` 只由手动单节点运行写。run 快照与文档完全解耦。
- 锁序：run 文件独立 `withRunLock`；子任务资金仍走 `createJob` 的 `withAdmissionLock`，run 锁内不反向拿 admission 锁。

## 6. 前端

- 画布加「运行」按钮（`canvas.runAll`）→ 报价弹层 → 确认建 run。
- run 进行中：节点卡片角标显示执行态；`GET /api/canvas-runs/:id` 轮询（3s）。
- 节点产物 overlay：加载画布时拉最新 run，节点显示 `nodeExecution.jobId` 对应产物（无 run 时回退 `node.jobId`）。
- 终态 toast：成功 / 部分失败（列失败数）/ 已取消 / `price_changed` 引导重新报价；`uncertain_submit` 引导创作页恢复中心。
- 沿用 BEM + `data-*` + 字典，不引组件库。

## 7. 测试与门禁（修订 7）

新增 `src/lib/canvas/run-graph.test.ts`：环拒绝、容量拒绝、无提示词拒绝、他人素材 404、同 key 重放同 run、异参 409、`quote_stale`、依赖失败 → blocked、取消不起新节点且重启后继续收敛、幂等查回接管（崩溃窗口）、一素材多节点、`price_changed` 拦截、`uncertain_submit` 透传。

门禁：`tsc --noEmit` → `eslint src` → `pnpm test` → `pnpm build`；**改 UI 后按 AGENTS.md 跑 `pnpm e2e`**（修订：不再以 build 代替 UI 回归）。本轮不做生产操作。

## 8. 风险与取舍

- 报价不落盘 + 执行时价校验双保险：建 run 时图变 → `quote_stale`；执行期价变 → 节点级 `price_changed`。两关都比「按旧快照扣新价」诚实。
- 并行提交所有 ready 节点受 `MAX_QUEUED_JOBS_PER_USER` 自然限流；queue_full 等待而非失败。
- 泵周期内扫所有用户非终态 run：内测规模无感，目录清单即索引。
- run 结果不落文档是取舍：换来「运行绝不干扰编辑」，代价是展示层多一次 run 查询；手动单节点运行维持原写回行为。
