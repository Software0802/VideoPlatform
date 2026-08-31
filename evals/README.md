# Harness baseline 评测集

`prompts.json` 是 M2.0 的固定回归输入，共 20 条：

- 5 个 Grok 原生视频模式：T2V、I2V、R2V、Edit、Extend
- 中文 / 英文各一组
- 每个模式覆盖两个边界档位（最短/最长或源片时长边界）

当前仓库只提供输入和人工评分规范，不会在 `pnpm test` 中自动调用上游，也不会伪造生成质量结果。

## 校验

```bash
pnpm run evals:check
```

## 运行记录

真实评测完成后，把脱敏结果写入 `evals/runs/YYYY-MM-DD.json`。记录至少包含：

- case id、job id、provider、model
- 请求参数和实际输出时长
- `costUsdEstimate`、`costUsdActual`（若上游返回 ticks）
- 评分表中的五项分数、总分和备注

不要把 API key、Cookie、完整上游响应中的认证信息或私人媒体提交到仓库。
