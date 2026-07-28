# v4 Turn Pipeline 接口契约

> 状态：Implemented Freeze 1  
> 负责人：Codex（工程定稿），Claude（评测与数据字段复核）  
> 适用任务：T-02、T-03  
> 变更规则：阶段名称、Commit 边界、错误语义或 trace 字段发生变化前，先更新本文档。

## 1. 目标

将现有 Orchestrator 中的一轮回复拆成七个可观察、可替换、可消融、可回放的阶段：

```text
Perceive → Interpret → Retrieve → Deliberate → Compose → Validate → Commit
```

迁移期间保持以下公开行为兼容：

- `orchestrator.reply(message, opts)`；
- `orchestrator.reply(message, { stream: true })`；
- `orchestrator.replyStream(message, opts)`；
- 返回对象中的 `text`、`parts`、`emotionLabel`、`goals`、`turnPlan` 等既有字段；
- `memory.recall()` 和 `memory.observe()` 的既有调用方式。

## 2. 核心不变量

1. Perceive 到 Validate 是回复计算区，不提交长期状态。
2. 只有 Commit 阶段可以写入 history、memory、relationship、state、story 或外部投影视图。
3. Commit 操作必须使用稳定 `eventId` 幂等；同一事件重试不得重复推进状态。
4. 每个阶段只读取前序上下文并返回 patch，不原地修改输入。
5. 阶段失败必须显式标记为 `failed` 或 `degraded`，不得静默伪装成成功。
6. 可降级阶段失败时继续运行；不可降级阶段失败时终止回复。
7. trace、评测与 debug 失败不得阻断回复。
8. `fact_core` 不得被流水线任何阶段改写。

## 3. TurnContext

```js
{
  version: 1,
  turnId: string,
  eventId: string,
  userId: string,
  companionId: string,
  userMessage: string,
  historyUserMessage: string,
  startedAt: number,
  now: number,
  options: object,

  perception: object | null,
  interpretation: object | null,
  evidence: object | null,
  decision: object | null,
  composition: object | null,
  validation: object | null,
  commit: object | null,

  stageResults: {
    perceive?: StageResult,
    interpret?: StageResult,
    retrieve?: StageResult,
    deliberate?: StageResult,
    compose?: StageResult,
    validate?: StageResult,
    commit?: StageResult
  },

  diagnostics: {
    warnings: object[],
    errors: object[]
  }
}
```

`TurnContext` 是一次 turn 的事实载体。阶段只能通过返回 patch 增加字段。

## 4. StageResult

```js
{
  stage: "perceive" | "interpret" | "retrieve" |
         "deliberate" | "compose" | "validate" | "commit",
  status: "ok" | "degraded" | "skipped" | "failed",
  startedAt: number,
  endedAt: number,
  latencyMs: number,
  patch: object,
  warnings: object[],
  error: {
    name: string,
    message: string,
    code?: string
  } | null
}
```

阶段错误对象不得包含密钥、完整 Prompt 或私人数据。

## 5. 七阶段职责

### 5.1 Perceive

输入：

- 原始用户消息；
- 短期历史；
- 当前时间；
- 渠道元数据；
- event ID。

输出 `perception`：

```js
{
  normalizedMessage,
  history,
  gapHours,
  sceneType,
  sceneLocks,
  temporalSignals,
  channel
}
```

禁止：

- 调用回复模型；
- 写长期状态；
- 决定最终回复行为。

### 5.2 Interpret

输入：

- perception；
- 当前 affect、relationship、life、intimacy、world 和 story 快照。

输出 `interpretation`：

```js
{
  stateSnapshot,
  relationshipState,
  relationshipStage,
  bodySituation,
  emotion: {
    label,
    distribution?,
    confidence?,
    target?,
    evidence?
  },
  unfinished,
  storyBeat,
  sessionThread
}
```

解释结果属于“推断”，不能直接当成用户事实写入 Belief。

### 5.3 Retrieve

输入：

- perception；
- interpretation；
- 检索策略与上下文预算。

输出 `evidence`：

```js
{
  query,
  memoryHits,
  memoryBlock,
  beliefs,
  prospective,
  profile,
  relationshipNarrative,
  world,
  story,
  provenance,
  budget
}
```

Retrieve 只收集和选择证据，不决定回复态度。

### 5.4 Deliberate

输入：

- perception；
- interpretation；
- evidence。

输出 `decision`：

```js
{
  goals,
  candidates,
  selectedAction,
  constraints,
  turnPlan,
  structuredPlan,
  samplingHints,
  rationaleCodes
}
```

`rationaleCodes` 只记录可公开的机器理由，不存储隐藏思维链。

Narration 和 desire 在本阶段只能作为软证据：

- narration 不参与认知决策；
- desire 不得作为硬覆盖规则。

### 5.5 Compose

输入：

- perception；
- interpretation；
- evidence；
- decision。

输出 `composition`：

```js
{
  promptParts,
  messages,
  draftText,
  draftParts,
  model,
  usage,
  streamed
}
```

Compose 负责表现形式和模型调用。Narration 若保留，只能位于本阶段。

### 5.6 Validate

输入：

- composition；
- decision；
- scene locks 和时间一致性约束。

输出 `validation`：

```js
{
  accepted,
  finalText,
  finalParts,
  checks,
  repair,
  safety
}
```

Validate 可以请求有限次数重写，但不得修改长期状态。

### 5.7 Commit

输入：

- 已通过 Validate 的最终回复；
- eventId；
- 本轮需要提交的认知事件。

输出 `commit`：

```js
{
  eventId,
  status,
  history,
  enqueued,
  projections,
  idempotentReplay
}
```

Commit 负责：

- 写入短期与持久历史；
- 投递 after-reply 事件；
- 触发 memory、belief、relationship、state、story 等消费者；
- 记录最终 trace；
- 触发非阻塞媒体任务。

Commit 不负责：

- 改写已经发送的回复；
- 重新执行模型决策；
- 在缺少 eventId 时进行不可幂等的多次写入。

## 6. 错误与降级语义

| 阶段 | 默认是否可降级 | 降级行为 |
|---|---|---|
| Perceive | 否 | 输入不合法则拒绝本轮 |
| Interpret | 是 | 使用最小中性状态 |
| Retrieve | 是 | 空证据继续回复 |
| Deliberate | 是 | 使用最小默认计划 |
| Compose | 否 | 主模型失败可切备用模型；全部失败则本轮失败 |
| Validate | 是 | 保留原稿并标记未完成的检查 |
| Commit | 是 | 回复照常返回，提交进入重试队列并明确标记 |

不得使用空 `catch {}` 丢失阶段状态。允许降级，但 trace 必须记录。

## 7. Trace 契约

每轮 trace 新增：

```js
{
  pipelineVersion: 1,
  turnId,
  eventId,
  stages: [{
    stage,
    status,
    latencyMs,
    warningCodes,
    errorCode
  }],
  commitStatus,
  replayOf?
}
```

已有 token、成本、memory hits、prompt bytes 和总延迟字段继续保留。

评测可依赖：

- 阶段状态；
- 分段延迟；
- evidence 数量和来源；
- decision 的公开理由码；
- validation 检查结果；
- commit 是否成功。

评测不得依赖隐藏思维链。

## 8. Replay 契约

离线 replay 至少支持两种模式：

1. `decision-replay`：固定 perception、interpretation、evidence，重新运行 Deliberate 以后阶段；
2. `compose-replay`：固定 decision 和 evidence，只比较模型与 Prompt 表现。

Replay 默认禁止 Commit。显式传入测试 store 时才允许写入隔离数据。

## 9. 迁移策略

当前完成度：

- Slice A：完成；
- Slice B：完成；
- Slice C：完成；
- Slice D：完成；
- `decision-replay` / `compose-replay`：完成；
- Commit 同进程 eventId 幂等：完成；
- 跨进程 Commit 竞争仲裁：完成基础版；注入 `SupabaseTurnEventStore` 后由
  `(user_id, companion_id, event_id)` 唯一键保证只有一个实例取得写权限；
- 崩溃恢复：待完成；`processing` 事件当前宁可阻止重复副作用，也不会自动抢占重放。

### 9.1 Turn Event Ledger

`src/orchestrator/turnEventStore.js` 定义 Commit 账本接口：

```js
claim(scope)             // 原子取得事件写权限
complete(scope, result)  // 标记投影提交完成
fail(scope, error)       // 标记同步提交失败
get(scope)               // 查询审计状态
```

生产环境通过 `deps.turnEventStore` 向 Orchestrator 注入
`SupabaseTurnEventStore`。未注入时保留原有单进程 Set 幂等，避免旧部署在 SQL
迁移前产生行为变化。数据库迁移见 `sql/turn_events.sql`。

账本提供跨进程 duplicate suppression，但暂不宣称跨多个外部存储的 exactly-once：
history、memory、媒体等投影尚未共享单个数据库事务。若进程在 claim 后崩溃，事件保持
`processing`，后续恢复器应按各投影自身 eventId 幂等能力逐项补偿。

### Slice A：流水线内核

- 新增通用 pipeline runner；
- 不改现有 Orchestrator 行为；
- 单测阶段顺序、patch 合并、降级、失败与 trace。

### Slice B：Commit 收口

- 将非流式与流式共同的 history、afterReply、媒体任务和 trace 收口；
- 保持返回结构不变。

### Slice C：阶段抽取

- 依次迁移 Perceive、Interpret、Retrieve、Deliberate；
- 每迁移一段先做行为对照测试。

### Slice D：Compose 与 Validate 统一

- 非流式与流式共用相同校验和后处理契约；
- stream 只改变 token 传输方式，不改变认知决策。

## 10. T-02 冻结条件

满足以下条件后 T-02 可标记完成：

- 七阶段职责无重叠；
- Commit 是唯一长期写边界；
- 评测所需字段已定义；
- 错误与降级语义已定义；
- replay 模式已定义；
- Claude 确认字段足够支撑 T-04/T-05/T-09；
- 后续破坏性变更必须更新本文档。
