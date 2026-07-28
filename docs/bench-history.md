# Benchmark history

只收录 `mode = live` 的行 (真实管线 + 真实模型)。复现命令: `npm run bench:memory` / `npm run eval:dialogue` / `npm run bench:ablation`; 明细在 `bench/results/`。

~~2026-07-27 的两行 offline 占位记录已删除: 其 "1.00/3.00" 来自硬编码的假答案, 不含任何信息。~~

| 日期 | 基准 | 模式 | Overall | Recall@5 | MRR | 说明 |
|---|---|---|---:|---:|---:|---|

## R1/R2 检索对比 (2026-07-28)

| 配置 | Overall | Recall@5 | MRR | p95(ms) | Cost |
|------|---------|---------|-----|---------|------|
| heuristic-vector | 0.92 | 1 | 0.9625 | 5152 | $0.0172 |
| heuristic-hybrid | 0.92 | 1 | 0.9625 | 6831 | $0.0172 |
| llm-hybrid | 0.90 | 1 | 0.9750 | 13941 | $0.0194 |
| activation-hybrid | 0.88 | 1 | **1.0000** | **3429** | $0.0174 |

决策：hybrid p95 增量 +1679ms > 150ms 门槛，故 R1 **不切换** heuristic-hybrid；R2 推荐 **activation-hybrid**（MRR 完美 + 最低延迟）。

## E3 消融 (2026-07-28，基线 2.99/5)

**立即删除**：monologue (Δ -0.51)、behaviorPolicy (Δ -0.51)。
**无法证明增益**：moodGating、reconsolidation、narration、story、desire。全部按 v3 红线列入重构名单。详见 [docs/ablation-report.md](ablation-report.md)，总成本 $0.2823。

## 运行审计

- 2026-07-27：在 VPS 隔离目录以生产 Supabase 与生产模型配置启动 E1；真实管线进入 `Memory.observe()` 后，OpenAI `text-embedding-3-small` 返回 HTTP 429 `insufficient_quota`，因此没有生成基线数字。失败运行产生的 `bench_` 数据已由 `bench/clean.js` 清除，各表核验残留为 0。
- 2026-07-27：F3 数据水位为 604 条记忆、215 条含 `access_log`，最长观测跨度 42.1 天；未达到方案要求的至少 60 天，因此不拟合、不替换 `forgetRate`。
- 2026-07-27：VPS 已配置主 LLM 与独立回复模型，但尚未配置显式 `JUDGE_*` / `LABEL_*`。后续可复用独立回复模型作为 judge/label，配置后必须在结果中保留模型来源与独立性标记。
| 2026-07-27 | memory-v3 | live | 0.80 | 1.00 | 1.00 | 50 问 / $0.0285 / runTag=ms35av8w |
| 2026-07-27 | dialogue-v3 | live | 4.87 | — | — | 15 剧本 / $0.0434 / judge 稳定性 maxΔ=0.07 |
| 2026-07-28 | memory-v3 heuristic-vector | live | 0.90 | 1.00 | 0.97 | R1/R2基准 / $0.0172 / runTag=ms40vj0w |
| 2026-07-28 | memory-v3 heuristic-vector | live | 0.92 | 1.00 | 0.96 | R1基准(最终) / $0.0172 / runTag=ms424qu6 |
| 2026-07-28 | memory-v3 heuristic-hybrid | live | 0.92 | 1.00 | 0.96 | R1基准(hybrid重复) / $0.0172 / runTag=ms431xah |
| 2026-07-28 | memory-v3 llm-hybrid | live | 0.90 | 1.00 | 0.97 | R2候选 / $0.0194 / runTag=ms43sja7 |
| 2026-07-28 | memory-v3 activation-hybrid | live | 0.88 | 1.00 | 1.00 | R2候选(最优MRR) / $0.0174 / runTag=ms4545os |
