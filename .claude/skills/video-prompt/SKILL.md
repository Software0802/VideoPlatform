---
name: video-prompt
description: Lumen（流光视频工作室）的视频 prompt 与 Director 领域知识。写或改文生视频 / 图生视频 prompt、Director 系统提示（src/lib/harness/director.ts）、Identity Bible 与角色设定表 prompt（identity-sheet.ts）、评测用例（evals/prompts.json）、评分记录（evals/runs）时使用；凡是涉及"跨镜头一致性、shot 拆分、时长打包、路由 t2v/i2v/r2v/extend、Identity Bible 锁定项、评分 rubric"的任务都先读本 skill。
---

# video-prompt

Lumen 的产品目标是**跨镜头身份一致的连续视频**：同一个人在 30 / 45 / 60 秒里换镜头不换脸、不换发型、不换衣服，光线和色调不跳。所有 prompt 写法和 Director 约束都服务于这一点。评分 rubric（`evals/rubric.md`）的五个维度——面部/身份、发型、服装、光线、色调——就是"一致性"的定义，写 prompt 时脑子里要有这五个维度。

## Director 的硬约束（改 `DIRECTOR_SYSTEM_PROMPT` 或 schema 时必须同时满足）

- 目标时长只能是 30 / 45 / 60 秒；`packing.clips` 与 `shots` 各自的时长之和都必须等于目标时长。
- generate 片段 ≤ 15 秒，extend 片段 ≤ 10 秒——这是上游 Grok 的边界，不是偏好。
- 路由优先 `grok_i2v`、`grok_r2v`、`grok_extend`：有参考帧 / 参考资产时不要退回纯 t2v，否则身份没有锚点。
- 连续动作用 `extend`（且必须配 `grok_extend` 路由）；镜头切换用 `hard_cut` 或 `tail_chain`；`stitch.transition` 目前只实现了 `hard_cut`，Director 不能输出别的。
- 以上每条在 `directorPlanSchema.superRefine` 里都有校验。改完提示词跑 `pnpm test`（`director.test.ts`）确认计划仍能通过，否则 Director 会重试 3 次后失败。

## Identity Bible：把一致性写成可复用的锁定约束

- `style.palette / lighting / lens / era / doNotChange` 和每个角色的 `lockedTraits` 是所有 shot prompt 的共享前提。写 shot prompt 时显式引用锁定项（"保持深青色风衣、钨丝暖光、镜头语言不变"），不要指望模型自己记得。
- `doNotChange` 写具体可检的事物（发长、衣领形状、光向），不写抽象形容词——评分者能核对的才是约束。
- 角色设定表 prompt（`buildIdentitySheetPrompt`）固定要求正面 / 四分之三 / 侧面三视图、干净背景、无文字水印：它是后续 i2v / r2v 的参考图，画面里多一个元素就多一个漂移源。

## 单个 shot prompt 的写法

- 一句场景 + 一个明确的镜头运动 + 光线与色温 + 显式的"保持 X 不变"。参考 `evals/prompts.json`：`深夜雨巷……镜头平稳跟拍，保持连续的暖冷对比`。
- 中文、英文各写一套，不要机翻；两种语言都要出现同样的锁定项。
- 有首帧 / 参考图时用"画面中的人物…"指代，不再重新描述外貌——重复描述会和参考图打架。
- 长度受 schema 限制（≤ 2000 字符）；形容词堆砌不会提高一致性，锁定项才会。
- 评测用例要覆盖真实边界（最短 1s、最长 15s，extend 源片 2s / 15s），结构由 `scripts/validate-evals.mjs` 校验：20 条、5 种模式各 4 条、中英各 2 条。

## 通过标准（改 prompt 后用它判断"有没有变好"）

- 单条：`overall5 >= 4.0` 且 `durationOk`、`moderationOk` 为 true；评测集 ≥ 70% case 达标。
- 评分写入 `evals/runs/YYYY-MM-DD.json`（模板见 `evals/rubric.md`）。它是本 skill 最重要的改进信号：低分 case 的 `notes` 就是下一条要写进这里的原则。

## feedback-sources

- `.claude/feedback/video-prompt.jsonl` — 通用反馈记录（/fb 写入），按 `skill` 字段过滤
- `evals/runs/*.json` — 人工评分；`overall5 < 4.0` 或任一布尔门槛为 false 的 case 视为负反馈，重点看 `notes`
