# Evidence Budget v1

## 目标

Retrieve 先保持原召回与重排算法不变，再回答第二个问题：

> 哪些已召回证据值得占用本轮 Prompt？

v1 只处理长期记忆与知识图谱块，避免同时改动历史、人格和状态段导致无法归因。

## 选择模型

每条结构化命中计算：

```js
{
  relevance,
  necessity,
  confidence,
  freshness,
  contradictionRisk,
  charCost,
  utility,
  utilityPerChar
}
```

当前效用函数：

```text
utility =
  relevance × 0.38
  + necessity × 0.28
  + confidence × 0.18
  + freshness × 0.12
  - contradictionRisk × 0.30
  + 0.04
```

选择器按“硬事实优先 → utility/char → utility → 原排序”确定顺序，在
`maxChars=2200`、`maxItems=7` 内贪心选取。`fact_locked` 的第一条证据允许突破极小
预算，保证硬事实不会因错误配置完全消失。重复文本只保留一条，已 superseded 的证据
受到高冲突惩罚。

## Prompt 与诊断

MemoryAdapter 始终返回 `{ block, hits, knowledge }`。Retrieve 使用选中 hits 重新生成
memoryBlock，未选中的证据不会进入 Prompt，但保留以下诊断：

- raw/selected/dropped 数量；
- char/token 预算估算；
- 每条证据的效用分量；
- selected/dropped reason code。

持久 trace 只保存聚合计数和理由码，不保存额外记忆正文。

## 消融

`ablation.evidenceBudget=false` 恢复原始 memoryBlock。建议 Claude 使用同一批场景比较：

- Prompt memory bytes；
- naturalness / consistency；
- hallucination；
- recall-related judge 分数；
- dropped reason 分布。

## v2 边界

v2 再把最近历史、关系状态、用户画像、故事线、生活与世界状态统一转成候选证据。进入
v2 前先验证 v1 没有降低事实正确率，且 token 节省具有统计意义。
