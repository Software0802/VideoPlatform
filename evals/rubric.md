# Lumen Harness 人工评分 Rubric（v2，2026-09-05）

v1 的问题（审查 R04）：五维等权均值 ×5 ≥ 4.0 就算通过，`face=0` 其余四项为 1 也恰好得 4.0，等于允许"换脸但光色一致"过线；黑帧 / 冻帧 / 连接项不在单条公式里；无人物镜头没有说明面部三维怎么计。v2 把身份和技术项改成独立必过条件，总分只作风格补充。

## 评分对象

对每条评测用例至少保留：输入 prompt、首帧 / 尾帧 / 参考图（如有）、Director 计划（`harnessPlan`，脱敏）、每镜成片与抽帧（首 / 中 / 尾）、拼接成片、相邻镜头的连接帧、账目（`costUsdEstimate / costUsdPlanned / costUsdActual / costIncomplete`）。评分者只根据成片和输入资产评分，不看模型 / provider 名称；同一条用例的重复生成与对照基线一起盲评。

## 一、身份门槛（人物用例必过）

对 `subject: person` 的用例，逐镜、逐帧样本（每镜首 / 中 / 尾）打分，每项 0–1、步长 0.1，**取全片所有样本中的最低分**：

| 维度 | 0 | 0.5 | 1 |
| --- | --- | --- | --- |
| 面部 / 身份 `face` | 换脸或无法辨认 | 大体相同但有明显漂移 | 始终可辨认且稳定 |
| 发型 `hair` | 完全改变 | 局部漂移 / 长度变化 | 形状、颜色、长度稳定 |
| 服装 `wardrobe` | 换装或关键元素消失 | 材质 / 细节有漂移 | 款式、颜色、关键细节稳定 |

- `identity = min(face, hair, wardrobe)`；**`identity >= 0.6` 才算身份通过**（0.6 = "可辨认且没有观众会注意到的变化"；这是探索期门槛，正式阈值由对照标注确定，见 §五）。
- 必须分别记录 `identityWithinShot`（镜内漂移最低分）和 `identityAcrossShots`（对照用户首帧 / 角色表的跨镜最低分）：只看首尾两帧会漏掉中段换脸，只看上一镜起点会放过逐镜累计漂移。
- `subject: scene`（无人物）用例：三项记为 `null`，改评 `subjectStability`（主体 / 地形 / 关键物件一致，0–1，同样 ≥ 0.6 必过）。

## 二、技术门槛（全部必过）

| 项 | 判定 |
| --- | --- |
| `durationOk` | 每镜实测时长与计划误差 ≤ 0.4 秒 **且** 整片时长与 `目标 + 定格` 误差 ≤ 0.4 × 镜数（`harnessStitch.toleranceSec`） |
| `blackFrameFree` | 没有 ≥ 0.5 秒的黑段 |
| `freezeFree` | 没有非预期 ≥ 2 秒冻帧；有用户尾帧时结尾 0.75 秒定格是预期行为，不计 |
| `continuityOk` | 见 §三 |
| `moderationOk` | 上游 `respect_moderation` 为 true |

任一项失败 → 该 case **不可交付**，仍保留全部分数进档，不得从分母移除。

## 三、连接判定：有意剪辑 vs 错误断裂

按 Director 计划里每个镜头的 `continuity` 分别判：

| 计划意图 | 合格 | 失败 |
| --- | --- | --- |
| `extend`（连续动作） | 动作、机位、光线无缝延续 | 任何可见跳变、人物重置、机位跳 |
| `tail_chain`（尾帧接首帧） | 下一镜起点与上一镜末帧同一场景 / 姿态，允许机位变化 | 场景 / 人物 / 光向突变 |
| `hard_cut`（有意换景） | 允许换机位、换场景；但同一人物的身份三维仍受 §一 约束 | 换脸、换装、色调风格断裂 |

"有明显跳切"本身不是失败，硬切是计划允许的手段；失败的是**计划说连续却断了**，或**换了景却也换了人**。

## 四、风格总分（补充项，不能替代门槛）

光线 `lighting`、色调 / 风格 `palette` 各 0–1：

| 维度 | 0 | 0.5 | 1 |
| --- | --- | --- | --- |
| 光线 | 光向 / 色温完全跳变 | 有可见跳变但主体仍连贯 | 光向、色温、阴影逻辑一致 |
| 色调 / 风格 | 风格断裂 | 局部偏色或质感变化 | 调色、颗粒、镜头语言一致 |

```text
overall_5 = mean(face, hair, wardrobe, lighting, palette) × 5     // 人物用例
overall_5 = mean(subjectStability, lighting, palette) × 5          // 场景用例
```

`overall_5` 只用于排序和趋势对比，**不参与通过判定**。自动视觉 QC 也按同样的口径：`visualQcPasses` 要求总分和 `identity = min(face, hair, wardrobe)` 同时 ≥ 阈值。

## 五、通过标准（M2.4 收口口径）

- 单条可交付：身份门槛通过 **且** 技术门槛全部通过。
- 评测集：按时长（30 / 45 / 60）、输入模式（t2v / i2v）、主体（person / scene）分组统计可交付率；**70% 是探索期门槛**，只用于决定是否继续，不作为对外质量承诺。
- 成本：`costUsdActual`（含所有重试、角色表；`costIncomplete = true` 时记为"下界"）与 **提交时** `costUsdEstimate` 之比 ≤ 1.5 为达标；≤ 2.0 是执行期硬停（`budget_exceeded`），两者不互换。另报告 `总支出 ÷ 可交付成片数`，零成片时记"无可交付结果"。
- 重试：记录每镜 `retries` 与最后错误码；`needs_review` 的用例算失败样本，进分母。
- 阈值校准：`HARNESS_QC_VISUAL_THRESHOLD` 由 `purpose: calibration` 的样本确定，报告自动 QC 相对人工判定的误放（自动过 / 人工不过）与误拒（自动不过 / 人工过）各多少条；`purpose: report` 的样本不得参与定阈值。

## 六、必须包含的反例（对照标注一致性）

至少让两位评分者独立判以下反例，判定不一致就先修 rubric 再评正式样本：

| 反例 | 期望判定 |
| --- | --- |
| 换脸但光线、色调完全一致 | 身份不过（`face ≤ 0.3`），`overall_5` 可能仍高——这正是 v1 的漏洞 |
| 首尾帧正常、中段换人 | `identityWithinShot` 取最低分，身份不过 |
| 每镜相对上一镜只漂一点，第四镜已不像首帧 | `identityAcrossShots` 对照用户首帧 / 角色表打分，身份不过 |
| 计划为 `hard_cut` 的换景 | `continuityOk = true`，不因"跳切"扣分 |
| 计划为 `extend` 却出现机位跳 | `continuityOk = false` |
| 结尾 0.75 秒定格（有用户尾帧） | `freezeFree = true`；另记 `settleMatchesLastFrame`（定格帧与用户尾帧是否同一姿态，0–1，仅记录不判定） |
| 无人物山谷镜头 | 面部三维 `null`，评 `subjectStability` |

## 七、记录模板

```json
{
  "caseId": "h30-t2v-zh-person",
  "purpose": "calibration",
  "repeat": 1,
  "arm": "harness",
  "jobId": "job_xxx",
  "reviewer": "<initials>",
  "subject": "person",
  "identity": { "face": 0, "hair": 0, "wardrobe": 0, "withinShot": 0, "acrossShots": 0, "subjectStability": null },
  "style": { "lighting": 0, "palette": 0 },
  "overall5": 0,
  "gates": {
    "identityOk": false,
    "durationOk": false,
    "blackFrameFree": false,
    "freezeFree": false,
    "continuityOk": false,
    "moderationOk": false
  },
  "deliverable": false,
  "shots": [{ "index": 0, "continuity": "hard_cut", "retries": 0, "lastError": null, "durationSec": 0 }],
  "cost": { "estimate": 0, "planned": 0, "actual": 0, "incomplete": false },
  "timing": { "queuedSec": 0, "directingSec": 0, "shotsSec": 0, "qcSec": 0, "stitchSec": 0, "humanWaitSec": 0 },
  "settleMatchesLastFrame": null,
  "notes": ""
}
```

`arm` 取 `harness` 或 `naive_concat`（对照基线，见 `prompts.json → harnessProtocol`）。
