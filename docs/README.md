# 文档索引

本文件 `docs/README.md` 区分当前操作依据与历史方案/证据。新会话先读 [handoff.md](handoff.md)，再按任务读取对应事实源；历史报告中的基线与测试结果不代表当前版本。

## 当前依据

| 文档 | 用途 |
| --- | --- |
| [handoff.md](handoff.md) | 当前能力、部署与验证状态、未完成事项 |
| [design.md](design.md) | 后端 as-built、数据与计费不变量、API、供应商协议 |
| [runbook.md](runbook.md) | 部署、恢复、账号与上游故障处理、已核实的环境事实 |
| [plan-repo-optimization-2026-09.md](plan-repo-optimization-2026-09.md) | 当前 R0–R7/J 路线；顶部记录拍板与执行状态 |
| [../AGENTS.md](../AGENTS.md) | 智能体执行规则与门禁，不重复 as-built 细节 |
| [../DESIGN.md](../DESIGN.md) | 当前 UI 规格、令牌、交互与 DOM 契约 |
| [../README.md](../README.md) | 项目入口与运行方式 |

## 领域方案与历史计划

这些文件保留决策时的正文，不作为现状说明；仍有效的契约由当前路线引用，实施情况看各文件顶部与 handoff。

| 文档 | 主题 |
| --- | --- |
| [plan-relay-provider-2026-09-13.md](plan-relay-provider-2026-09-13.md) | 中转注册、目录、治理与管理页；N3.1–N3.4 已落地，后续由 R2 排期 |
| [plan-next-2026-09-13.md](plan-next-2026-09-13.md) | 前一版排期；产品定位及 D1–D4 决策仍有效 |
| [plan-unimplemented-2026-09-08.md](plan-unimplemented-2026-09-08.md) | Reservation、Agent、Canvas、支付与运维契约引用源 |
| [plan-harness-provider-agnostic-2026-09.md](plan-harness-provider-agnostic-2026-09.md) | Harness 供应商无关化与角色三视图 |
| [plan-dag-canvas-run-2026-09-12.md](plan-dag-canvas-run-2026-09-12.md) | DAG 报价、冻结、运行与恢复 |
| [plan-dag-run-slice2-2026-09-12.md](plan-dag-run-slice2-2026-09-12.md) | DAG 总价预留、审批与内容寻址复用 |
| [plan-h-account-notifications-2026-09-12.md](plan-h-account-notifications-2026-09-12.md) | 账户页、持久通知、错误本地化与移动端 |
| [plan-agent-i18n-subscription-2026-09.md](plan-agent-i18n-subscription-2026-09.md) | 智能体、多语言与订阅初版方案 |
| [plan-architecture-2026-09.md](plan-architecture-2026-09.md) | 余额、作品管理、稳态、安全与运维治理 |
| [plan-frontend-backend-adaptation.md](plan-frontend-backend-adaptation.md) | 产品模型、规格、素材复用与充值界面的接入 |
| [plan-kling-video.md](plan-kling-video.md) | 可灵协议与视频计价接入 |
| [plan-ui-genius-app.md](plan-ui-genius-app.md) | Genius 换壳与 DOM 契约 |
| [plan-users-quota.md](plan-users-quota.md) | 用户、会话、归属、配额与媒体留存 |
| [plan.md](plan.md) | 早期阶段计划 |
| [architecture.md](architecture.md) | Phase 0 架构与历史决策 |

## 历史审查与验收证据

| 文档 | 范围 |
| --- | --- |
| [review-repo-2026-09-13.md](review-repo-2026-09-13.md) | dbead84 全仓审查，21 条 finding；修复进度看当前交接 |
| [review-2026-09-13.md](review-2026-09-13.md) | 当时的专项审查与验证边界 |
| [review-2026-09-08.md](review-2026-09-08.md) | 资金与执行恢复 R01–R09 |
| [review-2026-09-05.md](review-2026-09-05.md) | 2026-09-05 审查快照 |
| [review-2026-09-02.md](review-2026-09-02.md) | 2026-09-02 审查快照 |
| [review-2026-08-29.md](review-2026-08-29.md) | 初期审查快照 |
| [acceptance-2026-09-13.md](acceptance-2026-09-13.md) | 真实上游与生产 DAG 验收记录，不代替质量校准 |

## 仓库外层参考

- `design_handoff/design_handoff_genius_app/README.md` 与 `Genius App.dc.html`：UI 交接原型；有意偏离以当前 `DESIGN.md` 为准。
- `evals/README.md`、`evals/rubric.md`、`evals/prompts.json`：评测输入、授权素材要求与评分口径；缺运行记录就不声称质量已校准。
- `scripts/backup-restore.md`：备份恢复命令；涉及生产数据的操作必须先确认目标与维护窗口。
- `PRODUCT.md`、`IDEA.md`：历史产品探索；当前定位以优化计划引用的三项卖点为准。
