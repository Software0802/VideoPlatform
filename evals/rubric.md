# Lumen Harness 人工评分 Rubric（v1）

## 评分对象

对每条评测用例至少保留：输入 prompt、首帧/参考图（如有）、生成成片，以及相邻镜头的连接帧。评分者只根据成片和输入资产评分，不看模型/provider 名称。

## 一致性五维评分

每项使用 **0–1**，步长 0.1：

| 维度 | 0 | 0.5 | 1 |
| --- | --- | --- | --- |
| 面部 / 身份 | 换脸或无法辨认 | 大体相同但有明显漂移 | 始终可辨认且稳定 |
| 发型 | 完全改变 | 局部漂移 / 长度变化 | 形状、颜色、长度稳定 |
| 服装 | 换装或关键元素消失 | 材质/细节有漂移 | 款式、颜色、关键细节稳定 |
| 光线 | 光向/色温完全跳变 | 有可见跳变但主体仍连贯 | 光向、色温、阴影逻辑一致 |
| 色调 / 风格 | 风格断裂 | 局部偏色或质感变化 | 调色、颗粒、镜头语言一致 |

默认总分为五项等权平均，再换算为 5 分制：

```text
overall_5 = mean(face, hair, wardrobe, lighting, palette) × 5
```

## 连接与技术门槛

另记以下布尔项和备注：

- `duration_ok`：实测时长与目标误差 ≤ 0.4 秒
- `black_frame_free`：没有影响观看的黑帧
- `freeze_free`：没有非预期冻帧
- `continuity_ok`：镜头连接处没有明显跳切、角色重置或光线突变
- `moderation_ok`：上游 `respect_moderation` 为 true

技术门槛失败时仍保留五维分数，但该 case 不能计入“可交付通过”。

## 通过标准（M2.4 目标）

- 单条：`overall_5 >= 4.0` 且 `duration_ok`、`moderation_ok` 为 true
- 评测集：至少 70% case 达到单条标准
- 成本：实际单片成本不超过提交前预估的 1.5 倍
- 重试：记录每个 shot 的重试次数；超过 2 次转人工复核，不得静默丢弃

## 记录模板

```json
{
  "caseId": "t2v-zh-min",
  "reviewer": "<initials>",
  "scores": {
    "face": 0,
    "hair": 0,
    "wardrobe": 0,
    "lighting": 0,
    "palette": 0
  },
  "overall5": 0,
  "durationOk": false,
  "blackFrameFree": false,
  "freezeFree": false,
  "continuityOk": false,
  "moderationOk": false,
  "notes": ""
}
```
