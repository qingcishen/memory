# 技术突破 v1 — 五大系统全面升级设计文档

> 编写日期：2026-07-29  
> 状态：**结构实现与本地回归完成；真实数据/付费质量验收仍有待办**
> 优先级顺序：记忆系统 > 情绪系统 > 亲密系统 > 穿搭系统 > 世界系统

---

## 背景

现有系统已完成生产验收修复 sprint（CEE P0-P2 全部修完，1842/1842 测试通过），但核心五大系统存在结构性技术债：

- **记忆系统**：R2 检索（activation-hybrid）验证完毕却未切默认；无记忆层级化；无跨会话工作记忆。
- **情绪系统**：仅 8 种离散标签覆盖过窄；M1 与 CEE 双轨情绪未统一；纯 heuristic 推断丢失复杂信号。
- **穿搭系统**：无天气联动；无学习用户偏好；亲密场景不驱动穿搭变化。
- **世界系统**：完全自由文本，无结构化地理/日历；weather.js 孤立未接入。
- **亲密系统**：只做阈值门控；事后关系状态没有回暖；无跨天性张力弧线。

本文档给出每个系统的**审计结论、突破目标、实现方案**，和逐步落地的开发 Sprint 计划。

---

## 一、记忆系统突破

### 1.1 现状审计

| 组件 | 文件 | 状态 | 问题 |
|------|------|------|------|
| 记忆门面 | `src/memory.js` | 稳定 | 无层级化；无跨会话 working memory |
| 向量+激活引擎 | `src/engine/` | R2 验证完毕未切默认 | activation-hybrid MRR=1.0 仍 opt-in |
| 图扩散 | `src/engine/graph.js` | 稳定 | kNN 图仅进程内，大语料下扩散稀疏 |
| 知识图谱 | `src/knowledge/` | 存在但未接入主 recall | entity-relation 抽取有但多跳遍历缺 |
| 记忆巩固 | `src/existence/memoryConsolidation.js` | 生产级 | 仅 CEE 私有记忆；主 memory 无定期压缩 |
| 遗忘模型 | `src/reflect.js::findForgettable` | 存在但未调用 | 从未自动触发剪枝 |
| 重巩固 | `src/memory/reconsolidate.js` | 存在 | 召回时可触发但频率低 |

**核心问题（按严重性）：**

1. **R2 检索未切默认**（P0）：activation-hybrid MRR=1.0 vs heuristic-vector 0.9625，差距显著，仍是 opt-in。
2. **无记忆层级**（P1）：随时间记忆条数线性增长，无 episode cluster → semantic summary 压缩，长期用户 recall 质量下降。
3. **知识图谱孤立**（P1）：`observeKnowledge()` 存入实体关系，但 `recall()` 不走知识图谱路径，K1 事实只是存着不用。
4. **遗忘从未触发**（P2）：`findForgettable()` 有逻辑，但 `Memory` 类没有任何定时调用，记忆只增不减。
5. **跨会话工作记忆缺失**（P2）：每次对话从冷状态 recall；上次对话结尾的"心绪"（CEE private memory）没有桥接主记忆系统。

### 1.2 突破目标

**M-1：R2 切换**（立刻，1天）
- 把 `PARAMS.retrieval.hybrid = true` 改为 activation-hybrid 的默认值
- 验收：bench 结果 MRR ≥ 0.97，Recall@5 = 1.0

**M-2：知识图谱接入 recall**（5天）
- `src/knowledge/recall.js` 实现多跳实体遍历
- `engineRecall()` 在向量候选基础上融合知识图谱结果（RRF 第三路）
- 新增 `src/knowledge/graph.js`：邻接表 + 2 跳扩散

**M-3：记忆层级化压缩**（7天）
- 每 N 条 episode 自动聚类 → LLM 生成语义摘要 → 存 `summary` 类型记忆
- 参考 MemGPT / A-MEM 思路：旧 episode 不删除，但降权并链接摘要节点
- 新增 `src/memory/compress.js`：`compressEpisodeCluster(userId, companionId)`
- 调度：CEE heartbeat > 24h silence 后触发（与 consolidation 共享触发时机）

**M-4：自动遗忘**（3天）
- 在 `Memory.observe()` 末尾添加概率性遗忘触发（1% 概率 / 每次 observe）
- `findForgettable()` 判定：importance < 3 + base-level < 阈值 + 最近 90d 未访问
- 保护规则：fact_locked / dyad / type=relationship 不遗忘

**M-5：跨会话工作记忆桥接**（4天）
- CEE `memoryConsolidation.js` 生成的 private memory 通过 `Memory.observe()` 以 `type=working_memory` 写入主记忆
- 下次会话 recall 时 `working_memory` 优先级提高（wCtx × 1.3）
- 有效期 48h（超过后降权为普通 episode）

### 1.3 实现计划

```
Sprint M-1（1天）：
  修改 src/params.js: retrieval.hybrid = true，默认启用 activation-hybrid
  运行 bench 验证（npm run bench:memory）

Sprint M-2（5天）：
  新建 src/knowledge/graph.js
  修改 src/knowledge/recall.js：增加 knowledgeGraphRecall()
  修改 src/engine/index.js：engineRecall() 融合第三路知识图谱结果
  测试：src/knowledge/__tests__/recall.test.js

Sprint M-3（7天）：
  新建 src/memory/compress.js
  修改 src/existence/memoryConsolidation.js：24h 触发 compress
  修改 src/memory.js：observe 后调用 compressIfNeeded()
  测试：test/memory-compress.test.js

Sprint M-4（3天）：
  修改 src/memory.js：observe() 末尾添加 maybeForgot()
  修改 src/reflect.js：finalizeForgettable() 实际删除记录
  测试：test/memory-forget.test.js

Sprint M-5（4天）：
  修改 src/existence/memoryConsolidation.js：private memory 同步写主记忆
  修改 src/engine/activation.js：working_memory type 得 wCtx 加成
  测试：test/cross-session-bridge.test.js
```

---

## 二、情绪系统突破

### 2.1 现状审计

| 组件 | 文件 | 状态 | 问题 |
|------|------|------|------|
| 关系状态机 | `src/state/affect.js` (570行) | 稳定 | 与 CEE 情绪双轨 |
| 离散标签 | `src/state/emotionLabel.js` | 8个标签 | 覆盖太窄，缺期待/担心/害羞/暧昧 |
| 情绪残留 | `src/state/emotionResidue.js` | 生产级 | 只对 8 个标签设计 sticky |
| 情绪共鸣 | `src/state/emotionResonance.js` | 轻量 | 仅影响展示层 valence，不写库 |
| 情绪账本 | `src/state/emotionJournal.js` | 稳定 | 最多 20 条，不持久化到主记忆 |
| CEE 情绪层 | `src/existence/continuousState.js` | 独立 | current_emotion / emotion_intensity 与 M1 双轨 |
| heuristic 推断 | `src/state/affect.js::inferHeuristicDeltas` | 关键词匹配 | 漏失反语/委婉/上下文依赖情绪 |

**核心问题：**

1. **情绪空间过小**：8 个标签覆盖不了"期待面试结果""担心ta在忙""害羞被夸""暧昧游走""感动被照顾"等日常高频情绪。
2. **双轨情绪无统一**：M1 `affect.js` 维护 `mood.valence` 连续值，CEE 维护 `current_emotion` 离散字符串 + `emotion_intensity`。两者通过 `emotionDesireBridge.js` 松耦合，但没有单一真相来源。结果：有时 M1 显示"开心"但 CEE 显示"neutral"，prompt 注入逻辑必须查两处。
3. **纯 heuristic 丢失信号**：`inferHeuristicDeltas()` 靠正则匹配。"随便"被当敷衍处理，但"你比较忙的话随便"的语义是体贴。LLM 推断是低频增强但没有明确的"何时触发"策略。
4. **无情绪弧线追踪**：emotionJournal 只留 20 条转换记录，无法回答"她这周整体情绪如何"或"上次见面后她情绪有没有好转"。
5. **情绪不生成记忆**：重要情绪事件（如激烈争吵、感动时刻）不存为 episodic memory，下次对话无法召回感受。

### 2.2 突破目标

**E-1：扩展情绪标签到 16 个**（2天）
- 新增 8 个：`期待`、`担心`、`害羞`、`暧昧`、`感动`、`无聊`、`骄傲`、`烦躁`
- 为每个新标签设计 sticky 参数、推断规则
- 更新所有下游消费（emotionResidue.js / emotionJournal.js / promptKit）

**E-2：统一 M1 与 CEE 情绪（双轨合并）**（5天）
- 确立**单一真相**：CEE `state.emotional` 为权威情绪源
- M1 `affect.js` 的 `mood.valence` 作为数值底座，不再单独维护离散标签
- `inferEmotionLabel()` 从 CEE 情绪状态推导，而非从 M1 state
- 迁移路径：新字段逐步替换，旧字段保留 2 个版本

**E-3：LLM 情绪推断触发策略**（3天）
- heuristic 推断置信度低时（语句 > 15 字且无关键词命中）触发 LLM 推断
- `inferDeltasLLM()` 已存在但调用时机不明确，添加 `shouldLLMInfer(text)` 判断函数
- 成本控制：LLM 推断最多每 3 轮触发一次

**E-4：情绪弧线追踪**（3天）
- CEE `state.emotional` 新增 `weekly_distribution`：`{ labels: {}, dominant: string, trend: 'improving'|'stable'|'declining' }`
- heartbeat 每天更新弧线分布（取 emotionJournal 最近 7 天数据计算）
- 弧线注入 system prompt（"她这周整体偏 [dominant] 基调"）

**E-5：情绪记忆化**（2天）
- emotionJournal 中强度 ≥ 0.7 的事件，在 `Memory.observe()` 时以 `type=emotion_event` 写入主记忆
- recall 时 emotion_event 类型参与情绪共鸣（emotionResonance.js）

**E-6：情绪→穿搭联动**（1天，依赖 E-1/穿搭系统）
- 情绪 `无聊` → 偏向 casual/home 穿搭；`期待(约会)` → 偏向 date 穿搭；`烦躁` → 偏向舒适宽松款

### 2.3 实现计划

```
Sprint E-1（2天）：
  修改 src/state/emotionLabel.js：EMOTION_LABELS 扩到 16 个
  修改 src/state/emotionResidue.js：DEFAULT_STICKY 补充 8 个新标签参数
  修改 src/state/emotionLabel.js::inferEmotionLabelRaw：补充新标签推断规则
  测试：test/emotion-labels-extended.test.js

Sprint E-2（5天）：
  修改 src/existence/continuousState.js：emotional 字段扩展
  修改 src/state/affect.js：去掉独立离散标签推断，从 CEE state 读
  修改 src/existence/personalityCompiler.js：情绪层从 CEE state 读
  保留兼容：旧 API 透传，新 API 标记为 v2
  测试：test/emotion-unify.test.js

Sprint E-3（3天）：
  新建 src/state/emotionInference.js：shouldLLMInfer() + runLLMInfer()
  修改 src/state/affect.js::updateFromTurn：集成 shouldLLMInfer 门控
  测试：test/emotion-llm-infer.test.js

Sprint E-4（3天）：
  修改 src/existence/continuousState.js：新增 weekly_distribution 字段
  修改 src/existence/heartbeat.js：每天调用 updateEmotionArc()
  新建 src/existence/emotionArc.js：updateEmotionArc() 实现
  测试：test/emotion-arc.test.js

Sprint E-5（2天）：
  修改 src/memory.js::observe：接收本轮新增情绪账本事件，强度 ≥ 0.7 时安全写入
  新建 src/state/emotionMemory.js：受控摘要 + eventId 幂等
  修改 src/state/emotionResonance.js：接入 emotion_event 类型记忆
  测试：test/emotion-memory.test.js
```

---

## 三、亲密系统突破

### 3.1 现状审计

| 组件 | 文件 | 状态 | 问题 |
|------|------|------|------|
| 核心状态机 | `src/state/intimacy.js` (853行) | 生产级 | 只做阈值门控，无场景脚本 |
| 知识库 | `src/state/intimacyKnowledge.js` (204行) | 稳定 | 静态体位/行为目录，无动态解锁 |
| 关系耦合 | `src/memory.js::observe` | 有接口 | `intimacyAffect` 反馈到 M1，但强度弱 |
| 事后恢复 | aftercare_need 追踪 | 存在 | 没有映射到 M1 closeness 回暖 |
| 时间弧线 | 无 | 缺失 | 跨天性张力积累逻辑缺失 |

**核心问题：**

1. **只做门控不做叙事**：系统判断是否进入 foreplay/peak/aftercare 阶段，但阶段内的情绪、语言、节奏脚本依赖通用 LLM，缺乏专门的亲密场景叙事层。
2. **事后无关系回暖**：`aftercare_need` 记录但 M1 `closeness` / `tension` 几乎不受亲密度影响。真实关系里亲密行为显著加深情感连接。
3. **无跨天张力弧线**：`sexual_tension` 可以积累，但没有"已经三天没有亲密接触，今晚的气氛特别敏感"这类跨天弧线感知。
4. **consent 被动记录**：`consent.active` 存在但 prompt 层没有生成自然的意愿确认时刻。"你确定吗"类的确认不自然、过于直白。
5. **无亲密记忆**：亲密场景不生成 episodic memory，无法在后续对话中自然引用（"上次那个……"）。
6. **repertoire 静态**：虽然记录了已有体验，但没有"她主动引入新体验"的主动机制。

### 3.2 突破目标

**I-1：事后关系回暖**（2天）
- `aftercare_need > 0` 时，在下一轮 `Memory.observe()` 中加 `affectDelta`：`closeness += 0.04`, `tension -= 0.06`
- aftercare 完成（`scene_phase = cooldown` 后 2h 内有对话）额外 `closeness += 0.03`
- 修改 `src/state/intimacy.js::evolveIntimacy()`

**I-2：跨天张力弧线**（3天）
- `sexual_tension` 按开放度、libido 与沉默时长连续积累（上限 0.9）
- CEE heartbeat 检测：`sexual_tension > 0.6 + days_without_intimacy > 2` → `proactive_desire` 加权
- 注入 prompt 层：张力 > 0.5 时添加"气氛微妙"暗示

**I-3：亲密场景记忆**（3天）
- `Memory.observe()` 根据权威 before/after 首次进入 `peak` / `aftercare`，写入 `type=intimate_memory`
- 使用固定安全事实摘要，不接收或保存显式对话正文；`eventId + phase` 幂等
- `intimate_memory` 在日常、romantic、关系底色与关系故事中均不可见，只在 intimate 场景中优先

**I-4：自然 consent 节点**（2天）
- 在 `src/state/intimacy.js` 中新增 `consentCueNeeded()` 检测
- 场景从 flirting → foreplay 时，生成一个自然的意图确认提示词片段
- 修改 `src/appearance/promptKit.js` 的亲密场景 prompt 注入逻辑

**I-5：场景叙事脚本层**（5天）
- 新建 `src/state/intimacyScript.js`：根据 `scene_phase + arousal + body_focus` 生成叙事 beat
- beat 包含：`{ scene_beat, pace_instruction, sensory_focus, emotional_tone }`
- 每个 beat 注入 system prompt（相当于给 LLM 一个"导演指令"）
- 支持的 beat 模板：flirting × 3，foreplay × 5，peak × 4，aftercare × 3
- beat cursor 只在完整 Commit 成功后推进，并随 SessionThread 持久化以支持冷启动续拍

### 3.3 实现计划

```
Sprint I-1（2天）：
  修改 src/state/intimacy.js：getAfterglowDelta() 函数
  修改 src/memory.js::observe：intimacy.afterglowDelta 注入 affect 合并
  测试：test/intimacy-core-acceptance.test.js

Sprint I-2（3天）：
  修改 src/state/intimacy.js：evolveIntimacyOverTime 添加 tension 积累
  修改 src/existence/heartbeat.js：张力弧线检测 + desire 权重加成
  修改 src/existence/continuousState.js：sexual_tension 字段
  测试：test/intimacy-core-acceptance.test.js

Sprint I-3（3天）：
  新建 src/state/intimacyMemory.js：权威 phase 迁移 → 安全摘要
  修改 src/memory.js::observe：intimate 场景结束时调用
  修改 src/engine/index.js / src/retrieve.js：intimate_memory 场景隔离
  测试：test/intimacy-memory.test.js + test/intimacy-memory-observe.test.js

Sprint I-4（2天）：
  修改 src/state/intimacy.js：新增 consentCueNeeded()
  修改 StateLayer / Orchestrator：透传转换前状态与当前反应
  测试：test/intimacy-core-acceptance.test.js

Sprint I-5（5天）：
  新建 src/state/intimacyScript.js：beat 模板库 + generateBeat()
  修改 Orchestrator / SessionThread / TurnCommit：注入并在成功提交后持久化 cursor
  测试：test/intimacy-script.test.js + test/intimacy-beat-orchestrator.test.js
```

---

## 四、穿搭系统突破

### 4.1 现状审计

| 组件 | 文件 | 状态 | 问题 |
|------|------|------|------|
| 穿搭状态 | `src/state/outfit.js` (902行) | 稳定 | 无天气联动；无偏好学习 |
| 分类体系 | `src/state/outfitTaxonomy.js` (345行) | 完整 | 静态 |
| 穿搭卡片 | `src/state/outfitCards.js` (674行) | 完整 | 固定目录，无用户反馈更新 |
| 日常造型 | `src/state/dailyLook.js` (452行) | 稳定 | 无历史去重；无天气约束 |
| 外观门面 | `src/appearance/index.js` (36行) | 轻量 | 未接入 world/weather |
| 外观 prompt | `src/appearance/promptKit.js` (201行) | 稳定 | 未反映亲密级别变化 |

**核心问题：**

1. **完全不知道天气**：`weather.js` 存在但 `dailyLook.js` 不调用它。夏天穿冬装，冬天穿薄裙。
2. **用户反馈零记录**：用户夸了某件衣服，系统毫无响应。`outfitCards.js` 是固定目录。
3. **约会造型重复**：没有"约会时不重复最近 7 天的 date look"逻辑。
4. **亲密场景无过渡**：亲密 phase 升高时 outfit 不变（intimacy.js 和 outfit.js 无耦合）。
5. **情绪不影响穿搭**：她今天心情很差，但可能还是穿着明媚的碎花裙。

### 4.2 突破目标

**O-1：天气接入**（2天）
- `dailyLook.js::composeDailyLook()` 接收 `weatherContext`（温度、降水、风）
- 天气约束：T < 15°C → layering；T > 30°C → breathable fabric；rain → covered shoes
- 修改 `src/appearance/index.js::getDailyLook()` 从 `WorldDimension.weather()` 读取

**O-2：用户偏好学习**（3天）
- 新增 `src/state/outfitPreference.js`：`{ preferred_styles: [], preferred_items: [], disliked: [] }`
- `src/memory.js::observe()` 扫描用户消息中的"好看""喜欢你穿这个""换一套"等反馈
- 反馈写入 outfitPreference，`dailyLook.js` 生成时按偏好加权选择

**O-3：date look 去重**（1天）
- `outfit.js` 的 `daily_key` 扩展为历史列表（存最近 14 条）
- `composeDailyLook()` 在 date context 下排除最近 7 天使用过的 id

**O-4：亲密→穿搭过渡**（2天）
- `intimacy.scene_phase = 'flirting'` 时，outfit context 切为 'intimate' 前置准备
- `intimacy.scene_phase = 'aftercare'` 时，切为 'home' 宽松款（浴袍/睡衣）
- 修改 `src/state/outfit.js::contextForIntimacy()`（新函数）

**O-5：情绪着装**（1天）
- `情绪=无聊/烦躁` → context 权重向 home/casual 偏移
- `情绪=期待` → context 权重向 date/outing 偏移
- `情绪=开心` → 允许更多鲜艳色彩标签
- 修改 `dailyLook.js::pickContextByMood()` 函数

### 4.3 实现计划

```
Sprint O-1（2天）：
  修改 src/state/dailyLook.js：接收 weatherContext 参数
  修改 src/appearance/index.js：调用 WorldDimension.weather()
  测试：test/outfit-weather.test.js

Sprint O-2（3天）：
  新建 src/state/outfitPreference.js
  修改 src/memory.js::observe：扫描穿搭反馈
  修改 src/state/dailyLook.js：按偏好加权
  测试：test/outfit-preference.test.js

Sprint O-3（1天）：
  修改 src/state/outfit.js：daily_key 扩展为数组
  修改 src/state/dailyLook.js：去重逻辑
  测试：test/outfit-dedup.test.js

Sprint O-4（2天）：
  修改 src/state/outfit.js：contextForIntimacy()
  修改 src/memory.js::observe：intimacy phase 变化时调用
  测试：test/outfit-intimacy.test.js

Sprint O-5（1天）：
  修改 src/state/dailyLook.js：pickContextByMood()
  测试：test/outfit-emotion.test.js
```

---

## 五、世界系统突破

### 5.1 现状审计

| 组件 | 文件 | 状态 | 问题 |
|------|------|------|------|
| 世界状态 | `src/world/index.js` (137行) | 极简 | 完全自由文本，无结构化字段 |
| 天气 | `src/world/weather.js` (73行) | 存在 | 孤立，无外部数据源，与其他系统无联动 |

**核心问题：**

1. **全是自由文本**：`arc / atmosphere / last_event` 三个字符串字段，无法结构化查询（"今天几度？""她在哪个城市？"）
2. **LLM 全权决策**：`evolve()` 每轮调 LLM 判断是否更新，成本高、不稳定。稳定事实（城市、季节）不该 LLM 决定。
3. **无日历意识**：不知道今天是周几、是否节假日、用户有没有提到近期重要事件。
4. **weather.js 孤立**：有状态结构但不与天气 API 集成，也不被 outfit 消费。
5. **世界影响其他系统路径缺失**：atmosphere 注入了 system prompt，但没有直接参数化影响情绪基线或穿搭选择。

### 5.2 突破目标

**W-1：结构化世界事实**（2天）
- `defaultWorldState()` 扩展：添加 `{ location, timezone_offset, season, weather, events: [] }`
- `location` = 用户/角色所在城市（从对话中抽取 + 用户配置）
- `events` = 最近 5 条用户提到的未来事件（面试/旅行/约会/节假日）

**W-2：分离稳定事实与动态弧线**（2天）
- `stable_facts: { city, season, relationship_stage }` — LLM 不改动，只能通过系统设置更新
- `arc / atmosphere` — LLM 仍然演变
- 修改 `evolve()` 使其只修改 arc/atmosphere/last_event，不修改 stable_facts

**W-3：天气接入用户配置城市**（3天）
- 从 `stable_facts.city` 推导天气（可接 OpenWeatherMap 或基于季节/月份的模拟天气）
- `weather.js` 实现 `fetchWeather(city)` → 缓存 1h，失败时退回季节模拟
- `WorldDimension.weather()` 返回 `{ temperature, condition, humidity }`

**W-4：日历意识**（2天）
- `worldCalendar.js`：`isChinaHoliday(date)`, `daysToEvent(events, date)`
- 在 system prompt 中注入"今天是周X / 距[xxx]还有N天"
- 节假日前 1 天、节日当天、节后第一天有特殊情绪加成

**W-5：世界→情绪基线耦合**（2天）
- 天气恶劣（rainy / cold） → 情绪基线 valence -0.05，arousal -0.1
- 节假日 → 情绪基线 valence +0.05
- `src/world/worldAffectCoupling.js`：`getWorldAffectOverride(worldState, date)`

### 5.3 实现计划

```
Sprint W-1（2天）：
  修改 src/world/index.js：defaultWorldState 扩展
  修改 evolve()：不再修改 stable_facts
  测试：test/world-structure.test.js

Sprint W-2（2天）：
  修改 src/world/index.js：分离 stable/dynamic 字段
  测试：test/world-stable.test.js

Sprint W-3（3天）：
  修改 src/world/weather.js：fetchWeather(city) + 缓存
  修改 src/world/index.js：WorldDimension.weather()
  测试：test/world-weather.test.js

Sprint W-4（2天）：
  新建 src/world/worldCalendar.js
  修改 src/world/index.js：toWorldPrompt 注入日历
  测试：test/world-calendar.test.js

Sprint W-5（2天）：
  新建 src/world/worldAffectCoupling.js
  修改 src/memory.js::observe：读取 worldAffectOverride → 合并 extraDeltas
  测试：test/world-affect.test.js
```

---

## 六、整体 Sprint 优先级与顺序

### 阶段一（立刻，约 1 周）：基础建设

| 编号 | Sprint | 天数 | 优先级理由 |
|------|--------|------|-----------|
| M-1 | R2 切换默认 | 1 | 已验证 MRR=1.0，零风险，立刻提升召回 |
| E-1 | 情绪标签扩展到 16 | 2 | 影响所有情绪推断，地基改动先做 |
| I-1 | 亲密事后关系回暖 | 2 | 高价值，代码改动极小 |
| O-1 | 穿搭天气接入 | 2 | 依赖 W-3，可先用模拟天气 |

### 阶段二（约 2 周）：核心突破

| 编号 | Sprint | 天数 |
|------|--------|------|
| M-2 | 知识图谱接入 recall | 5 |
| E-2 | 情绪双轨统一 | 5 |
| I-2 | 亲密跨天张力弧线 | 3 |
| W-1/W-2 | 世界结构化 | 4 |
| O-2 | 穿搭偏好学习 | 3 |

### 阶段三（约 2 周）：深度联动

| 编号 | Sprint | 天数 |
|------|--------|------|
| M-3 | 记忆层级化压缩 | 7 |
| E-3/E-4 | LLM 情绪推断 + 弧线追踪 | 6 |
| I-3/I-4 | 亲密记忆 + consent | 5 |
| W-3/W-4/W-5 | 天气 + 日历 + 情绪耦合 | 7 |
| O-4/O-5 | 穿搭亲密/情绪联动 | 3 |

### 阶段四（约 1 周）：长尾与稳定

| 编号 | Sprint | 天数 |
|------|--------|------|
| M-4 | 自动遗忘 | 3 |
| M-5 | 跨会话工作记忆桥接 | 4 |
| E-5 | 情绪记忆化 | 2 |
| I-5 | 亲密场景叙事脚本 | 5 |
| O-3 | date look 去重 | 1 |

---

## 七、验收标准

标记口径：

- `[x]`：生产调用路径已接通，且有本地确定性测试或已有真实 bench 证据。
- `[ ]`：验收明确要求真实库存、人工金标或付费模型评测，本轮没有用模拟结果冒充。

### 记忆系统
- [x] M-1: activation-hybrid 已为默认；真实 bench MRR = 1.0，Recall@5 = 1.0
- [x] M-2（离线结构验收）: 2-hop 图谱作为 RRF 第三路接入；100 条确定性实体查询命中 85 条，并有 200ms 超时降级
- [x] M-3（结构验收）: `>200` 触发、24h 冷却、旧 episode 链接 reflection、不删除原记录
- [ ] M-3（性能验收）: 仍缺“同一会话真实库存 300 条记忆”的 recall p95 < 5s；现有 p95=3429ms bench 未证明库存为 300 条
- [x] M-4: 正好 90d 未访问 + importance<3 的无保护记忆自动清除；fact_locked / dyad / relationship / 私密事件受保护
- [x] M-5: 真实 `loadSessionThread → perceive → prompt` 跨会话路径可在首轮自动召回，且已消费桥不会泄漏到第三场会话

### 情绪系统
- [x] E-1（结构验收）: 16 个标签全部有确定性覆盖测试，并补齐 sticky / prompt 下游
- [ ] E-1（质量验收）: 尚无覆盖 16 类的人工金标集证明新标签 F1 ≥ 0.7；旧 8 类校准 artifact 的 macro-F1=0.346，不能作为通过证据
- [x] E-2: CEE 离散标签为单一真相，M1 提供数值 valence；100 轮方向一致 100/100（原“intensity 同向”表述无符号意义，已按 CEE valence 验收）
- [x] E-3: LLM 推断仅在 heuristic 置信度 < 0.5 时触发（每 3 轮最多 1 次）
- [x] E-4: 情绪弧线 weekly_distribution 在 3 天模拟数据后准确更新，并由 heartbeat 维护 7 天滚动窗口
- [x] E-5（结构验收）: 强度 ≥ 0.7 写 `emotion_event`，安全摘要、幂等重放并参与情绪共振
- [ ] E-5（质量验收）: 情绪记忆在 E3 bench 中 naturalness ≥ 3.2（本轮未运行付费模型评测）
- [x] E-6: 无聊/烦躁/期待/开心可驱动穿搭情境与风格，且不覆盖亲密场景

### 亲密系统
- [x] I-1: aftercare 后 M1 closeness 一次性 `+0.04`，完成后 2h 内再 `+0.03`（测试验证）
- [x] I-2: 高开放关系 sexual_tension 在 3 天沉默后 `>0.6`、上限 `0.9`（数学验证）
- [x] I-3: 亲密记忆使用独立类型、安全摘要和幂等键，日常召回/关系底色均不可见
- [x] I-4: consent cue 仅在 `flirting → foreplay` 转换触发，并通过完整关系/身体/stop 门控
- [x] I-5（结构验收）: 四阶段 15 个结构化 beat；普通、流式、冷启动、失败与重放均有回归测试
- [ ] I-5（质量验收）: E3 bench intimacy 场景 naturalness ≥ 3.5（本轮未运行付费模型评测，不能提前勾选）

### 穿搭系统
- [x] O-1: 气温 < 15°C 时日常造型 100% 包含保暖款（100 次模拟验证；高温/雨天各另有 100 次）
- [x] O-2: 用户夸赞某件衣服后，下次 outfit 中该 item 出现频率增加（100 vs 100 A/B：50% → 100%）
- [x] O-3: 连续 7 天约会造型无重复（循环测试）
- [x] O-4: flirting / foreplay 阶段 outfit.context = `intimate` 100% 覆盖，aftercare 回到 `home`
- [x] O-5: 情绪会即时改变穿搭情境/风格，并保留亲密内搭优先级

### 世界系统
- [x] W-1: worldState 包含 location / timezone / season / weather / events 结构化字段
- [x] W-2: stable_facts 经过 50 轮 evolve 和并发设置更新后保持不被 LLM 覆盖
- [x] W-3: 已知城市天气返回 temperature + condition + humidity，缓存 1h，失败回退稳定季节模拟
- [x] W-4: 中国节假日表、前后窗口、周几和事件倒计时均有测试
- [x] W-5: 恶劣天气相对晴天 valence 精确 -0.05、arousal -0.1；使用瞬时副本，避免每轮累计漂移

---

## 八、风险与约束

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| E-2 双轨合并迁移期数据不一致 | 中 | 保留旧字段 2 个版本，新代码读新字段兜底旧字段 |
| M-3 压缩引入 LLM 成本 | 中 | 只在 > 200 条记忆时触发，且每 24h 最多一次 |
| W-3 外部天气 API 依赖 | 低 | 失败时退回季节模拟，不 crash |
| I-5 叙事脚本增加 prompt 长度 | 低 | beat 注入控制在 150 tokens 内 |
| M-2 知识图谱多跳延迟 | 低 | 限制 2 跳，超时 200ms 时降级为向量路径 |

---

## 九、开发日志

| 日期 | 完成 Sprint | 备注 |
|------|------------|------|
| 2026-07-29 | 文档编写完成 | 代码实现从 M-1 开始 |
| 2026-07-29 | M-2 知识图谱 RRF 第三路 | `knowledgeEntityRecall` 接入 `engineRecall`，3路 RRF |
| 2026-07-29 | E-3 LLM 情绪推断触发 | `shouldLLMInfer` + `llmInferEmotionLabel`，异步 1/3 轮次 |
| 2026-07-29 | O-3 日期穿搭去重 | `recent_looks[14]` 存储，最近 7 天 avoidIds 过滤 |
| 2026-07-29 | W-4 中国节假日日历 | `upcomingHolidays()` 纯函数，注入 `toWorldPrompt` |
| 2026-07-29 | W-5 天气情绪基线耦合 | `weatherToValenceDelta()` + 临时状态注入 interpretTurn |
| 2026-07-29 | M-3 记忆层级压缩 | `src/memory/compress.js::compressEpisodeClusters()` |
| 2026-07-29 | M-4 自动遗忘剪枝 | `Memory.pruneStale()` 接入夜间维护 maintain |
| 2026-07-29 | O-4 亲密场景穿搭切换 | aftercare→home, flirting→date 上线 |
| 2026-07-29 | O-5 情绪驱动穿搭 | `applyEmotionToContext()` 偏移穿搭情境 |
| 2026-07-29 | M-5 跨会话工作记忆桥接 | `_buildCrossSessionBridge()` + session thread crossSessionContext |
| 2026-07-29 | E-4 情绪弧线追踪 | CEE `weekly_distribution` 字段 + `_observeTurn` 计数 |
| 2026-07-29 | E-5 情绪事件记忆重构 | journal 强事件经 Commit/队列进入 `Memory.observe`；安全摘要、事件幂等、resonance 接入 |
| 2026-07-29 | I-1/I-2 验收修复 | afterglow 一次性结算 + aftercare 完成回暖；72h 张力弧线和 heartbeat 注入时钟 |
| 2026-07-29 | I-3 亲密场景记忆重构 | `Memory.observe` 权威迁移写 `intimate_memory`；安全摘要、事件幂等、三层召回隔离 |
| 2026-07-29 | I-4 自然同意节点重构 | 只在 `flirting → foreplay` 转换触发；模糊短问、积极反应顺势、退缩立即停 |
| 2026-07-29 | I-5 结构化叙事脚本 | 四阶段 15 beat；cursor 仅在成功 Commit 后推进并随 SessionThread 持久化 |
| 2026-07-29 | 修复后全量回归 | 39 个测试文件、1911/1911；typecheck；golden 20/20；v2 14/14；live matrix 逻辑项 11/11（付费自然度评测仍待运行） |
| 2026-08-11 | 模型质量评测工作流收口 | probe/score/sweep/persona/full 阶段独立，当前配置缓存隔离与延迟统计修正；52 个测试文件、2037/2037 + typecheck 通过 |
