# D 包切片二：run 级预算预留 + 审批门 + 复用语义 实施计划

日期：2026-09-12。基线：`main` @ `5cc0397`（切片一已提交）。
状态：**已实装并通过全门禁**（2026-09-12，tsc / eslint / 1131 单测 / build / e2e 29 全绿）。方案已与用户对齐三项取舍；Codex 评审 `VERDICT: BLOCK`（1×P0 + 5×P1），逐条判定全部成立并已在本稿修订（各节「修订」标注），P0/P1 验收项均已被 `run-graph.test.ts` 用例覆盖（复用采纳、孤儿 transfer 计占用、坏文件失败关闭、审批门、regen 闭包）。来源：`docs/plan-unimplemented-2026-09-08.md` §5.3–5.5 中切片一「明确不做」的三项。

> 实现与本文档的一处出入：`decideCanvasRunApproval` 的同决策重放走 `updateCanvasRun` 返回 `undefined`（不写盘）幂等交回；「锁内幂等复核」落在 `withAdmissionLock` 而非 run 锁（并发双发只有一个能冻结成功）。

## 1. 范围

切片一已交付「整图校验→报价→确认→逐节点执行→取消→恢复」。本切片补齐 D 的剩余语义：

- **Run 级总预算预留**：确认报价即冻结 `totalCny`（会员/已购分池口径与 `reserveJobFunds` 相同），调度节点时把该节点份额**转移**给子 Job，run 终态释放未消耗部分——「建 run 成功 = 全程钱够」，替代一期「逐节点扣、可能中途余额不足」。
- **运行中人工审批门**：建 run 时可选定「执行前需再确认」的节点（默认勾视频节点——图便宜、视频返工贵）；节点就绪但被设门 → `awaiting_approval` 停住，`POST /api/canvas-runs/:id/approvals` 批准才提交，驳回即 `blocked` 并传播下游。
- **改图 stale/复用**：新 run 建时按 `inputHash` 链匹配最近一次 run 的成功节点——输入没变且产物还在 → 直接复用（报价 ¥0、不重复扣费）；产物已清理 → `blocked`/`output_purged`，不悄悄重生成；失败节点在新 run 自然重跑（无成功历史可复用）。

**明确不做**：run 内单节点原地重试（「新 run + 自动复用」等效覆盖，且幂等键已按 run 隔离）、quote `expiresAt`（hash 比对已等效于「图变/价变即失效」）、Approval 独立实体文件（决策落在 exec 上，预算上限就是冻结的 quote 份额，语义等价少一个存储实体）、审批策略的服务端记忆（每期由前端在建 run 时显式传 `approvalNodeIds`）。

## 2. Run 级预算预留

### 2.1 模型（修订：transfer 绑定 jobId，会计公式改为「恰好计一次」）

`CanvasRun` 新增：

```ts
reservation?: {
  amountCny, memberCny, purchasedCny,           // 建 run 时冻结的总价与分池
  remainingCny, remainingMemberCny, remainingPurchasedCny,  // 尚未转移出去的余量
  transfers: Record<nodeId, { amountCny, memberCny, purchasedCny,
                              jobId,                           // 修订：份额锚定到具体 job
                              subscriptionId?, periodIndex? }>, // 会员归因随份额走
  subscriptionId?, periodIndex?,
  createdAt,
}
```

**资金口径（修订核心，解 P0）**：一份份额在任意时刻恰好计一次——

| 时刻 | 份额由谁计 |
| --- | --- |
| 未转移 | run `remaining*` |
| transfer 已落盘、job 文件未落盘（carve→writeJob 窗口、claim 抛错、进程崩溃） | transfer 记录（**jobId 的 job 不存在 ⇒ 该份额仍计占用**） |
| job 落盘且非终态 | `job.reservation`（job index 既有口径） |
| job 终态 / run 终态 | 已结算或释放，不再计 |

- 新函数 `runHeldFunds(userId)`：返回 `{remainingCny, remainingMemberCny, transferCny, transferMemberCny}`——扫该用户全部 run，只算 `status==="running"` 的；transfer 仅当其 `jobId` 在**全量** job 索引里查不到时才计入（job 存在则无论终态都不计：非终态由 job 自身预留计，终态已结算）。
- `loadBalanceUsage` 与 `heldMemberEarmarksCny`（subscription.ts 期次清零的「保住 earmark」不变量）**共用同一个 `runHeldFunds`**（修订：两处口径必须一字不差）；后者还需配合全量索引读（不能只看 nonTerminal）。
- **严格读（修订，解 P1-6）**：`runHeldFunds` 走严格路径——目录 ENOENT → 0；目录其它 IO 错 / 任一 `crun_*.json` 解析失败 → 抛 `billing_state_corrupt` 失败关闭（宁可挡住新预留，不静默漏计）。泵继续用容错版 `listActiveCanvasRuns`（坏文件只拖垮自己的 run，不拖垮别人）。
- run 转终态 → 余量与孤儿 transfer 都停计，**释放不需要写操作**；台账留 run 文件供对账。

### 2.2 转移（transfer，修订：单段临界区内「先锚定再扣」）

子任务的钱不能再让 `reserveJobFunds` 从头预留——那等于 run 持总价 + 子 Job 再持一份，双重预留。做法：

- `createJob` 增第三参 `opts?: { reserveFunds?: (priceCny, jobId) => Promise<JobReservation|undefined> }`：提供了就调它取代 `reserveJobFunds`（`rec.id` 在计价前已生成，jobId 此刻可得），调用点仍在 `withAdmissionLock` 临界区内原位置。
- sweep 传闭包 `(price, jobId) => carveRunShare(...)`——**直接原子读写 run 文件**（不走 `withRunLock`：sweep 已持有它，重入即死锁；锁序保持 run→admission，回调内不取任何锁）。
- carve 语义：
  - `transfers[nodeId]` 已存在 → **复用记录的分池份额**，把 `jobId` 改写成本次的新 jobId（覆盖上一条没落盘的孤儿 id），落盘，交回 `JobReservation`（含 subscriptionId/periodIndex）。
  - 不存在 → 校验 `remaining ≥ price`（不可达防御，违反抛 `internal_error`）、按「会员优先」从 `remainingMember` 先扣，记 `transfers[nodeId] = {split, jobId}` 并减余量，落盘，交回。
  - 回调同步改 sweep 内存里的 `run`（同一对象），`sweepOnce` 终写不会拿旧预留盖新台账。
- 这样 §2.1 的会计表在每个可观察落盘态上都恰好计一次：carve 落盘后 job 缺失 → transfer 计；job 落盘 → job 计、transfer 停计；无任何「两边都不算」的超卖窗口，也没有「恢复时重复承诺」——重试永远复用同一 nodeId 的台账份额。

### 2.3 崩溃窗口全序（修订）

| 崩溃点 | 落盘态 | 恢复行为 | 期间会计 |
| --- | --- | --- | --- |
| carve 后、writeJob 前 | transfer{split,jobId} 已记、job 缺失 | 下轮幂等查回 miss → createJob → 台账命中、份额复用、jobId 换最新 | transfer 计占用，不超卖 |
| writeJob 后、sweep 终写前 | transfer+job 都在 | 幂等查回命中接管 | job 计占用 |
| claim/其它在 writeJob 前抛错 | transfer 孤儿（jobId 永不落盘） | sweep 重试该节点 → 复用份额换 jobId | transfer 持续计占用至 job 落盘或 run 终态 |

### 2.4 建 run 路径（修订：锁内幂等复核，解 P1-2）

`createCanvasRun` 三段：

1. 锁外快路径：`findRunByIdempotencyKey` 命中 → 同参交回 / 异参 409；`readCanvas` + `computeQuote`（含复用判定，慢路径不占全局锁）。
2. `withAdmissionLock` 内：**再查一次同 key**（并发双发只有一个能过）、`readCanvas` 复核 revision 未变（变了 → `quote_stale`）、按 `totalCny` 走 `reserveJobFunds` 同款分池冻结成 `run.reservation`、写 run 文件——hold 落盘后才出锁。
3. 锁外 kickSweep。

余额不足 → 402，run 文件不留痕。`approvalNodeIds`/`regenerate` 校验（⊆ 生成节点）在锁外完成。

### 2.5 price_changed 交互

不变：提交前仍按报价快照校验归一价，不一致 → `failed`/`price_changed`，该节点份额留在 remaining 随终态释放，不按新价扣。

## 3. 审批门

- 建 run 请求体加 `approvalNodeIds?: string[]`（须 ⊆ 生成节点，否则 400）；存入 run（`run.gatedNodeIds`），参与 `requestHash`（不进 quoteHash——审批集合不改变「买什么」）。
- 执行位新状态 `awaiting_approval`：sweep 提交前若 `nodeId ∈ gatedNodeIds` 且无决策 → 置该态停住。
- `POST /api/canvas-runs/:id/approvals` `{nodeId, decision: "approve"|"reject"}`：
  - exec 非 `awaiting_approval`：同决策重放 → 交回 run（幂等）；异决策/时机已过 → 409 `invalid_state`。
  - approve → exec 记 `approval:{decision,decidedAt}`、状态回 `ready`，kickSweep。
  - reject → `blocked`/`approval_rejected`，既有 blocked 传播收尾下游。
- 取消语义扩展：`cancelRequestedAt` 下 `awaiting_approval` 一并标 `blocked`/`canceled`。
- `awaiting_approval` 是非终态，run 保持 `running`，泵周期照扫。

## 4. 复用与 stale

### 4.1 inputHash（修订：保序，解 P1-5）

`graph.ts` 新增 `nodeInputHash(graph, nodeId)`：递归内容寻址，inputs **保 `nodeInputs` 的画布顺序不排序**——执行器 `resolveRunImageInput` 按同顺序取「首个可用图」，顺序本身就是输入语义的一部分，两个素材换序 = 不同输入。

```
hash(node) = stableJsonHash({
  kind, mode, mergedPrompt, product ?? null,
  inputs: nodeInputs 顺序逐个映射 [
    material → `material:<uploadId>`,
    text     → 不单列（内容已并入 mergedPrompt）,
    gen dep  → `gen:<depNodeId>:<hash(dep)>`
  ]
})
```

任一上游输入变 → 自身 hash 变 → 下游连锁 stale。

### 4.2 regenerate 闭包（修订，解 P1-3）

`regenerate` 点名集的**生效集 = 该集合在 gen 依赖方向上的传递闭包**（强制重跑上游 ⇒ 下游产物基于旧输入，必须一并重跑）。报价与建 run 用同一规范化函数 `expandRegenerate(graph, requested)`，两处各自展开后参与 hash——用户传 A，实际生效 {A,B}，两端算出的集合与价格一致。

节点可复用 ⇔ `nodeId ∉ 生效集` 且命中 §4.3 的匹配。

### 4.3 复用判定（报价与建 run 共用）

- 候选源：该画布**最近一次**（`createdAt` 最大）有终态执行位的 run。
- 节点 `inputHash` 相同 且 对方 exec `succeeded` 且 `jobId` 的 `job.json` 在、`status==="succeeded"`、无 `artifactsPurgedAt`、产物文件 `statJobFile` 存在 → 复用：`exec.status=succeeded, jobId=旧 job, reused:true`。
- hash 相同但产物没了 → `blocked`/`output_purged`（不悄悄重生成；要重跑用 regenerate 点名）。
- 复用节点的下游照常从 `exec.jobId` 取产物复制，`resolveRunImageInput` 不改。

### 4.4 报价表达（修订：regenerate 进报价闭环，解 P1-4）

- `POST /api/canvases/:id/quotes` 改为收体 `{regenerate?: string[]}`（空体兼容）。
- `computeQuote(ownerId, doc, {regenerate})`：先 `expandRegenerate`，再逐节点判定复用；报价条目加 `inputHash`、`reused?: boolean`、`adoptedJobId?`；复用条目 `priceCny: 0`、summary 标「复用」。
- `quoteHash` 覆盖 `inputHash` + `adoptedJobId` + **生效 regen 集**——报价到建 run 之间产物被清 → hash 变 → `quote_stale`；建 run 体的 `regenerate` 与报价不一致 → 同样 `quote_stale`，强制走一次新报价确认。
- `totalCny` = 仅待执行节点之和 = 预留额。

## 5. API 与前端

- `POST /api/canvas-runs` 体：`{canvasId, quoteHash, idempotencyKey, approvalNodeIds?, regenerate?}`。
- `POST /api/canvases/:id/quotes` 体：`{regenerate?: string[]}`。
- 新增 `POST /api/canvas-runs/:id/approvals` `{nodeId, decision}`。
- 报价弹层：复用行标「复用 ¥0」且带「重新生成」勾选（勾选 → 带新 `regenerate` 重新报价）；可执行行带「执行前确认」勾选（gen_video 默认勾、gen_image 默认不勾）；底部文案改为「确认即冻结总价 ¥X，未用部分结束后释放」。
- run 面板：`awaiting_approval` 节点出「待批准」徽标 + 批准/驳回按钮；复用节点标「复用」徽标。
- i18n：canvas 命名空间补中英双份新键。

## 6. 测试与门禁（修订：补评审验收项）

新增用例：

- 建 run 冻结总价、`loadBalanceUsage` 计入；余额 < 总价 → 402 不留 run。
- 转移后无双重预留（run remaining + transfer + job.reservation 恰好计一次）。
- 崩溃窗口：carve 落盘后无 job → transfer 仍计占用；重试复用份额换 jobId；并发同 key 建 run 只建一个 / 异参 409（修订，P0+P1-2 验收）。
- 会员池：跨期结算保住 run `remainingMemberCny` + 孤儿 transfer 的 member 份额（修订，P0 验收）。
- 审批门：gated 节点停 `awaiting_approval`；approve 后提交；reject → blocked 传播；取消中含 awaiting → canceled。
- 复用：改下游文案重跑 → 上游复用 ¥0 不新建 job；产物已清 → `output_purged`；`regenerate` 上游 → 下游连锁重跑（修订，P1-3）；报价带 regenerate → 条目按实计价（修订，P1-4）；双素材换序 → inputHash 变（修订，P1-5）；run 文件损坏 → 准入失败关闭（修订，P1-6）。
- 全门禁：`tsc` → `eslint` → `pnpm test` → `pnpm build` → `pnpm e2e`。

## 7. 风险与不变量（修订）

- **锁序**：sweep 持 run 锁 → createJob 持 admission 锁 → carve 回调只做原子文件写（不取任何锁）。建 run 只在 admission 锁内做复核+冻结+写盘，不取 run 锁。无环。
- **会计恰好一次**：份额在 remaining / transfer(job 缺失) / job.reservation 三者间流转，任意可观察落盘态恰好计一次；所有中间态偏向「多计」而非「少计」。
- **全局锁占用**：建 run 的报价/复用重算放锁外；锁内只做幂等复核、revision 复核、冻结、写盘。
- **口径一致性**：`runHeldFunds` 是 run 侧占用的唯一实现，`loadBalanceUsage` 与 `heldMemberEarmarksCny` 共用；严格读，坏文件失败关闭。
- **复用确定性**：`inputHash` 输入保画布序；`regenerate` 生效集为 gen 下游闭包，报价与执行共用同一展开。
