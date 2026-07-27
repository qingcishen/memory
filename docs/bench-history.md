# Benchmark history

只收录 `mode = live` 的行 (真实管线 + 真实模型)。复现命令: `npm run bench:memory` / `npm run eval:dialogue` / `npm run bench:ablation`; 明细在 `bench/results/`。

~~2026-07-27 的两行 offline 占位记录已删除: 其 "1.00/3.00" 来自硬编码的假答案, 不含任何信息。~~

| 日期 | 基准 | 模式 | Overall | Recall@5 | MRR | 说明 |
|---|---|---|---:|---:|---:|---|

## 运行审计

- 2026-07-27：在 VPS 隔离目录以生产 Supabase 与生产模型配置启动 E1；真实管线进入 `Memory.observe()` 后，OpenAI `text-embedding-3-small` 返回 HTTP 429 `insufficient_quota`，因此没有生成基线数字。失败运行产生的 `bench_` 数据已由 `bench/clean.js` 清除，各表核验残留为 0。
- 2026-07-27：F3 数据水位为 604 条记忆、215 条含 `access_log`，最长观测跨度 42.1 天；未达到方案要求的至少 60 天，因此不拟合、不替换 `forgetRate`。
- 2026-07-27：VPS 已配置主 LLM 与独立回复模型，但尚未配置显式 `JUDGE_*` / `LABEL_*`。后续可复用独立回复模型作为 judge/label，配置后必须在结果中保留模型来源与独立性标记。
| 2026-07-27 | memory-v3 | live | 0.80 | 1.00 | 1.00 | 50 问 / $0.0285 / runTag=ms35av8w |
| 2026-07-27 | dialogue-v3 | live | 4.87 | — | — | 15 剧本 / $0.0434 / judge 稳定性 maxΔ=0.07 |
