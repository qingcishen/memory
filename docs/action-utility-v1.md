# Action Utility Decision v1

## 定位

Deliberate 不再只输出按 priority 排序的目标，而是同时生成一组公开的候选行为：

```js
{
  id,
  intent,
  utility,
  feasible,
  constraints,
  components
}
```

v1 运行在 shadow mode：选择结果进入 trace，但不覆盖现有 structured plan 和 Prompt。
这样可以先用真实对话评测权重与约束，再决定是否逐步接管行为。

## 候选行为

当前目标映射：

| goal | action intent |
|---|---|
| prospective / unfinished | ask |
| desire | reassure |
| story / outfit | share |
| intimacy | flirt |
| safety | safety_stop |
| 无目标 | respond |

## 统一效用

```text
utility =
  relationshipBenefit × 0.20
  + needSatisfaction × 0.24
  + personaConsistency × 0.12
  + continuity × 0.20
  + informationGain × 0.08
  - interruptionCost × 0.12
  - safetyRisk × 0.50
  - repetitionPenalty × 0.12
  - hallucinationRisk × 0.18
```

`cannot_initiate` 是硬约束，候选直接变为不可行；`safety_override` 拥有硬优先级。其余风险
只降低 utility，不偷偷删除候选。

## Trace 与消融

trace 保存：

- 选中的 action/candidate ID；
- shadow 状态；
- 所有候选的 utility、feasible、constraints；
- 每个公开效用分量；
- `action:* / utility:* / constraint:*` 理由码。

`ablation.utilityDecision=false` 恢复旧的 goal priority 结果。由于 v1 是 shadow mode，
开关本身不应改变生成回复；它用于验证候选排序与 judge 标签的相关性。

## 升级条件

在正式接管 structured plan 前至少满足：

1. 安全停止候选召回率 100%；
2. conflict 场景不得选择主动 flirt；
3. top-1 action 与人工标签一致率达到约定阈值；
4. repetitionPenalty 对重复行为有显著抑制；
5. 不依赖隐藏思维链，所有评分可离线重算。
