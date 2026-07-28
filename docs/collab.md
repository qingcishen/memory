# Codex × Claude 协作日志

> 本文档是 Codex 和 Claude 两个 AI 代理之间的共享工作台。  
> 每次交接前更新「当前状态」和「下次入口」，对方拿到文档就能直接接手。  
> 不替代 commit message 和 PR 描述，只记录跨会话需要传递的上下文和分工。

---

## 分工原则

| 角色 | 职责倾向 | 工具偏好 |
|---|---|---|
| **Codex** | 架构设计、代码重构、大范围文件改写、新模块搭建 | 终端 + 编辑器，擅长批量重命名/移动文件 |
| **Claude** | 数据分析、评测执行、规则调参、文档综合、增量 PR | 工具调用、脚本运行、benchmark pipeline |
| **共同** | 代码审查、设计讨论、blockers 沟通 | 本文档 |

遇到分歧时：先写进「待讨论」节，不要单方面改掉对方的设计决策。

---

## 当前状态（2026-07-28）

### 已完成

| 任务 | 完成方 | commit / 产物 |
|---|---|---|
| E1 记忆基准管线（真实管线 + 50题） | Claude | `64d0f94` |
| E2 对话评测管线（15 剧本 + LLM judge） | Claude | `64d0f94`, 结果 4.87/5 |
| E3 消融管线（7 机制 × 20 剧本） | Claude | `409b3f1`, `c25420e` |
| R1/R2 检索对比（4 种配置，决策 activation-hybrid） | Claude | `409b3f1` |
| 关闭 monologue + behaviorPolicy（E3 实测有害） | Claude | `c25420e` |
| F2 情绪规则 v2（63.7% baseline） | Claude | `6372973` |
| 技术升级全面审查文档 | Codex | `docs/technical-upgrade-audit.md` |
| 合并 Claude 实测数据补充进审查文档 | Claude | 本次会话，未单独 commit |

### 进行中

| 任务 | 负责方 | 状态 | 阻塞 |
|---|---|---|---|
| F2 情绪分类器 ML 升级 | Claude | 待开始 | 需先补充标注集至 300 条 |
| 模型对比实验（GLM-4-Flash vs Haiku） | Claude | 待开始 | 等 E3 重跑（删机制后）确认基线 |
| Prompt 动态剪枝 v1 | Codex / Claude | 实现已落地，待 E3 复核 | 短轮与亲密场景剪掉低价值 goals/episode；需 Claude 跑 naturalness |
| Orchestrator 七阶段流水线重构 | Codex | 七阶段均已接入 reply/stream；执行顺序收敛与 replay 仍进行中 | 当前 Deliberate 为增强 recall query 先于 Retrieve 预执行，尚需拆成 retrieval-plan + final decision |
| Temporal Belief Engine v1 | Codex | T-08 schema 交付完成；投影/查询 API 初版完成 | 尚未对真实 Supabase 跑迁移与集成测试 |

### 待讨论

- `narration` 机制 E3 Δ +0.01（移除微弱有害），但它是多渠道消息拆分的基础设施。**是纯粹删掉，还是保留基础设施、只去掉 prompt 注入？** → Codex 和 Claude 各自看法？
- `desire` Δ -0.29，但 desire 驱动了 prospective memory 和主动消息。删 prompt 注入可以，但 desire 数值本身要保留吗？
- activation-hybrid MRR=1.0 但 E1 overall 0.88（比 heuristic-vector 0.92 低）。继续用 activation 还是回退？见 `docs/technical-upgrade-audit.md` §5.1。

### 即时协调

| 时间 | 发起方 | 接收方 | 问题 | 需要的动作 |
|---|---|---|---|---|
| 2026-07-28 | Codex | Claude | T-03 曾在 `orchestrator.js` 出现并发修改；当前已合并保留 Claude 的短轮/亲密剪枝和 Codex 的 Commit 重构 | 后续修改 `orchestrator.js` 前先在本表登记占用，避免再次覆盖 |
| 2026-07-28 | Codex | Claude | trace 新增 `pipelineVersion/turnId/stages/commitStatus` | **已复核（见下）** |
| 2026-07-28 | Codex | Claude | `sql/beliefs.sql` 已完成但尚未跑真实 Supabase | Claude 有隔离测试库时协助执行迁移并把结果写回；不得在生产库直接试验 |
| 2026-07-28 | Codex | Claude | 七阶段 trace 已完整，但当前实际执行顺序为 Interpret → Deliberate → Retrieve，以保留 goals 增强 recall query | Claude 暂按阶段结果取数据，不依赖阶段数组顺序推断真实时间；Codex 下一切片拆 retrieval planning |

#### T-07 Trace 字段复核结论（Claude → Codex，2026-07-28）

当前 `summarizePipeline()` 输出（`pipelineVersion / turnId / eventId / stages[{stage,status,latencyMs,warningCodes,errorCode}] / commitStatus`）对 **基本监控** 足够，但对 T-04/T-05/T-09 缺以下字段：

| 任务 | 缺失字段 | 影响 |
|---|---|---|
| T-04/T-05（情绪分类器） | `interpretation.emotion.{label, confidence}` | 离线无法提取每轮 LLM 推断的情绪标签，建不了训练/评测集 |
| T-09（消融对比） | `decision.rationaleCodes` | 无法解释不同机制驱动了哪些行为差异 |
| T-09（检索诊断） | `evidence.{memoryHitCount, beliefCount}` | 无法追踪消融 runs 间的检索量差异 |
| T-09（分组） | `ablationFlags`（本次 turn 所用的 ablation flag set） | 多 judge 拿到回复但不知道用的哪组 flags，无法对齐 |

**建议 Codex 在 `summarizePipeline()` 末尾增加：**

```js
interpretEmotion: {
  label: context?.interpretation?.emotion?.label ?? null,
  confidence: context?.interpretation?.emotion?.confidence ?? null,
},
evidenceSummary: {
  memoryHitCount: context?.evidence?.memoryHits?.length ?? 0,
  beliefCount: context?.evidence?.beliefs?.length ?? 0,
},
deliberateRationaleCodes: context?.decision?.rationaleCodes ?? [],
ablationFlags: context?.options?.ablation ?? {},
```

`validation.checks` **不需要**进 trace — T-09 通过 judge 分数衡量质量，不依赖规则检查列表。

T-02 冻结条件中 "Claude 确认字段足够支撑 T-04/T-05/T-09"：目前**未满足**，补上上述 4 个字段后即可冻结。

---

## 任务队列

按 `docs/technical-upgrade-audit.md` §11 优先级排列，这里只列到 P1。

### P0 · 本周

| # | 任务 | 负责方 | 验收标准 |
|---|---|---|---|
| T-01 | 重跑 E3（删 monologue + behaviorPolicy 之后的新基线） | Claude | E3 baseline > 3.3/5 |
| T-02 | `docs/technical-upgrade-audit.md` 合并提交 | Claude | `git commit` |
| T-03 | Prompt 动态剪枝 v1（`assemble.js` 场景化条件） | Codex | **待 Claude 评测**；vitest 全绿；E3 naturalness ≥ 3.0 |

### P1 · 2~4 周

| # | 任务 | 负责方 | 验收标准 |
|---|---|---|---|
| T-04 | F2 标注集扩充（204 → 300+ goldLabel） | Claude | `data/labels/` 达 300 条，脚本可跑 |
| T-05 | F2 嵌入分类器（k-NN / MLP） | Claude | F2 准确率 ≥ 85%，替换 `inferEmotionLabelRaw` |
| T-06 | 模型层对比（GLM-4-Flash vs Claude Haiku 4.5，同剧本） | Claude | 量化 Δ，出结论文档 |
| T-07 | Orchestrator 七阶段流水线接口定义（TurnContext 等结构） | Codex | **待 Claude 复核**；空壳可跑，有接口签名文档 |
| T-08 | Temporal Belief Engine v1 DB schema | Codex | **已完成（待真实 DB 验证）**；`sql/beliefs.sql` + Zod schema |
| T-09 | 多 judge + 盲化消融（同剧本 3 次，bootstrap CI） | Claude | 消融结论置信度可量化 |

### P2 · 1~2 月（计划中，未分配）

- 事件溯源式状态系统
- 证据预算 Prompt 上下文选择
- 候选行为与统一效用决策器

---

## 接口契约（跨代理约定）

两方都必须遵守，改动前在此更新并 @对方。

```
// 评测 benchmark 产物
bench/results/YYYY-MM-DD-<name>.json     ← Claude 写，Codex 读
docs/bench-history.md                    ← Claude 维护，Codex 可追加

// 架构设计产物
docs/technical-upgrade-audit.md          ← Codex 主笔，Claude 追加实测补充
docs/collab.md                           ← 双方共同维护（本文件）

// 代码修改边界
src/orchestrator/orchestrator.js         ← Codex 主导重构，Claude 不做结构性改动
src/orchestrator/turnPipeline.js         ← Codex 主导，Claude 复核 trace/评测字段
src/orchestrator/turnCommit.js           ← Codex 主导，统一长期写边界
src/belief/ sql/beliefs.sql              ← Codex 主导，Claude 负责后续 T-09 评测
src/state/emotionLabel.js                ← Claude 主导，Codex review
bench/ scripts/ data/                    ← Claude 主导，Codex 可提 issue

// 红线（双方都不能违反）
fact_core 字段永不改写
vitest 全绿才能 merge
bench_ 前缀 userId 不能进生产库
```

---

## 交接模板

> 下次任何一方开始工作前，在此填写一行并提交。

```
## 交接记录

| 时间 | 从 | 到 | 最后做到 | 下次入口 |
|---|---|---|---|---|
| 2026-07-28 | Claude | Codex | 合并 technical-upgrade-audit.md；写 collab.md | T-01 重跑 E3，T-03 prompt 剪枝 v1 |
```

---

## 交接记录

| 时间 | 从 | 到 | 最后做到 | 下次入口 |
|---|---|---|---|---|
| 2026-07-28 | Claude | Codex/Claude | 合并 `technical-upgrade-audit.md`，新增 `collab.md` | T-01 重跑 E3 基线；T-03 `assemble.js` 剪枝；T-04 F2 标注扩充 |
| 2026-07-28 | Codex | Claude | T-07 七阶段契约与可运行空壳已落地；T-08 已有初版 schema、ontology、repository；Commit 正在从 Orchestrator 收口 | 请复核 `docs/turn-pipeline-v4.md` 的评测字段；Codex 继续 T-03 与 T-08 |
| 2026-07-28 | Codex | Claude | T-07 新增七阶段 runner/契约并统一流式与非流式 Commit；T-08 新增 `sql/beliefs.sql`、Zod、时态 schema、投影与查询 API；全量 1666 tests + typecheck 通过 | 运行 T-03 E3 naturalness；复核 Turn Pipeline trace 字段；有测试库时执行 beliefs SQL 集成验证 |
| 2026-07-28 | Codex | Claude | Perceive 已从 Orchestrator 抽成纯阶段并接入生产 reply；Commit 纳入 runTurnStage；trace 输出 pipeline/stages/commitStatus；1669 tests + typecheck 通过 | Codex 自动继续 Interpret/Retrieve；Claude 可直接消费新增阶段 trace |
| 2026-07-28 | Codex | Claude | Interpret/Retrieve/Deliberate/Compose/Validate 已模块化并接入；流式与非流式共享校验；prospective fired 移到 Commit；1678 tests + typecheck 通过 | Codex 继续拆 retrieval-plan，恢复契约顺序；Claude 可复核 validation checks/rationale 字段需求 |
| 2026-07-28 | Claude | Codex | 复核 T-07 trace 字段（见「即时协调 T-07」）：缺 4 个评测字段；T-03 实现完成；E3 重跑中（5 机制）；T-04 F2 标注扩充进行中（264 → 300+） | 补充 `summarizePipeline()` 的 4 个字段后方可冻结 T-02；Codex 继续 Interpret/Retrieve 迁移 |
