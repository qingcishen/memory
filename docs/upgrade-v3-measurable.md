# AI 伴侣 · 全面升级开发文档 v3(从"像人"到"可证明")

> 前两轮把机制建齐了(M/L/A/K 线)、把"像人"的三大缺失补上了(D/B/S 线)。
> 本文档回答下一个问题:**这些机制到底有没有用?** 现状是:心情门控、重构记忆、行为策略……没有任何一个机制的价值被数字证明过,全部参数是拍脑袋手调的,评测只有 44 行结构断言。**没有度量的机制堆砌 = 玄学。**
> v3 的目标不是加新功能,而是把已有系统变成三件事:**可度量(E 线)、可证伪(消融)、可学习(F 线)**,并把工程底盘(T 线)升级到能撑住前三件事。
> 配套文档:[开发文档与路线图](DEVELOPMENT.md)、[伴侣升级开发文档 v2](companion-upgrade-v2.md)、[编排器设计](orchestrator-design.md)。

---

## 0. 现状水位诊断(升级的出发点)

| 维度 | 现在有的 | 病灶 |
|---|---|---|
| 评测 | `examples/eval/companion-v2.eval.js`(44 行) | 只断言"prompt 里没出现内部词汇",**不度量对话质量与记忆准确率**。任何机制的存废都无法用数据裁决 |
| 检索 | pgvector top-k + `rerank`(similarity+recency+importance)+ ACT-R 激活引擎 | 单路向量召回,无关键词通道,无 rerank 模型;`engine/activation.js` 的野心没有基准可以证明自己 |
| 参数 | `src/params.js` 323 行魔法数字 | 全部手调,零数据支撑;`emotionLabel.js` 31 行 if/else 推情绪,准确率未知 |
| 可观测 | `console.error` + `opts.debug` | 每轮回复的记忆命中/prompt 体积/token 成本/分段延迟**不可追溯**,消融和调参无从谈起 |
| 测试 | 38 个手写 node 脚本用 `&&` 串联 | 无测试框架,单个失败即中断后续,无覆盖率,CI 反馈粗糙 |
| 数据 | 生产对话进 `chat_history` / `memories` | **没有数据飞轮**:线上数据不回流成标注集/基准集,系统不随使用变好 |

一句话:**技术含量不来自机制数量,来自"机制 → 度量 → 证据 → 迭代"的闭环。v3 就是建这个闭环。**

---

## 1. 设计原则

1. **功能冻结(★ v3 第一红线)**:E3 消融报告出来之前,不新增任何横向功能(新维度/新玩法/新渠道)。所有工时投给闭环。
2. **先度量,后优化**:任何"优化检索/调参/换模型"的 PR,必须附带基准数字前后对比,否则不合入。
3. **消融裁决存废**:每个子系统(内心独白/心情门控/重构记忆/行为策略/旁白)都要经历"关掉它,分数掉不掉"的审判。不掉分的机制进入删除/重构名单——**瘦身也是升级**。
4. **评测数据与生产数据隔离**:bench/eval 全部走 `bench_` 前缀的 userId,清理脚本一键删除;绝不污染真实用户记忆库。
5. **失败安全降级**(继承):trace/评测任何一步失败,回复照发,绝不影响线上路径。
6. **红线不动**(继承):`fact_core` 永不改写;既有 CI 断言持续通过。
7. **成本有账**:judge/评测用便宜模型 + 用量上限;每轮线上回复的 token 成本可查。

---

## 2. 接口契约冻结

```
// ---- T · Trace(地基, 一切度量的数据源) ----
// 每轮 reply() 产出一条 trace, JSONL 落盘 (logs/traces/YYYY-MM-DD.jsonl), 失败静默
type ReplyTrace = {
  ts, userId, companionId, eventId,
  userMessage, reply,
  memoryHits: [{ id, type, score, similarity }],   // 命中了哪些记忆、各自得分
  promptBytes: { persona, state, memory, history, total },
  llmCalls: [{ stage: 'monologue'|'reply'|'narration'|..., model,
               promptTokens, completionTokens, costUsd, latencyMs }],
  emotionLabel, behaviorPolicy, sceneType,
  totalLatencyMs, totalCostUsd,
}
trace.record(t: ReplyTrace) -> void                 // fire-and-forget, 永不 throw
trace.query({ day, userId }) -> ReplyTrace[]        // inspect.js / UI 消费
trace.dailyCost(day) -> { calls, tokens, costUsd }  // T3 成本日报

// ---- E · 评测闭环 ----
// E1 记忆基准: 题目集是"灌入对话 + 提问 + 标准答案"
type MemoryBenchCase = {
  id, kind: 'fact'|'update'|'temporal'|'multi-session'|'abstention',
  sessions: [{ daysAgo, turns: [{role, content}] }],  // 按时间序灌入
  question: string,
  expect: { answer?: string, mustMention?: string[], mustNotMention?: string[] },
}
runMemoryBench(cases, { judge }) -> {
  perKind: { [kind]: { accuracy } },                  // 判卷: 规则匹配 + judge 仲裁
  retrieval: { recallAt5, recallAt10, mrr },          // 检索层单独打分 (gold memory 命中率)
  overall,
}

// E2 对话质量 judge: 多轮剧本跑真编排器, 强模型按 rubric 打分
type JudgeRubric = 'memory_consistency' | 'persona_stability'
                 | 'emotional_fitness' | 'naturalness' | 'no_breaking'   // 各 1~5 分
runDialogueEval(scenarios, { judge, flags }) -> {
  perRubric: { [rubric]: mean }, overall,             // flags = 消融开关组合
  transcript: [...],                                  // 存档供人工抽查
}

// E3 消融: 同一份剧本 × 不同开关组合
type AblationFlag = 'monologue' | 'moodGating' | 'reconsolidation'
                  | 'behaviorPolicy' | 'narration' | 'story' | 'desire'
runAblation(scenarios, flags: AblationFlag[]) -> AblationReport
// 产出 docs/ablation-report.md: 每个机制一行 [开启分, 关闭分, Δ, 结论(保留/删除/重构)]

// ---- R · 检索升级 ----
retrieveMemories(userId, companionId, query, opts) 签名不变, 内部改造:
//   1) 双路召回: 向量 (现有 match_memories) + 关键词 (pg_trgm / tsvector)
//   2) RRF 融合去重 -> candidatePool
//   3) rerank: 现有启发式 | 'llm' (便宜模型对 top-20 打相关分) — params.retrieval.reranker 切换
// 所有改造以 E1 的 retrieval 指标为唯一裁判

// ---- F · 从数据学习 ----
// F1 标注集: trace + 强模型标注 -> 金标数据 (进 repo, jsonl)
//   datasets/emotion-labels.jsonl   { stateSnapshot, desires, lastTurns, goldLabel }
//   datasets/importance-labels.jsonl{ content, goldImportance }
evalEmotionLabel(dataset) -> { accuracy, confusion }   // 现有 inferEmotionLabel 先测底分
fitForgetRate(accessLogs) -> { d, r2 }                 // ACT-R 衰减指数从真实 access_log 拟合
```

契约冻结后 E/R/F 三线可并行;线上路径只在 orchestrator/llm/retrieve 各接一个埋点或开关。

---

## 3. 分阶段计划

### T · 工程底盘(先做,其余三线都踩在它上面)

**T1 测试框架迁移(vitest)**
- 引入 vitest;38 个 `examples/*.test.js` 迁为 `test/*.test.js`(assert 改 expect,纯搬运不改逻辑,一次 PR 一批)
- `npm test` = `vitest run`;`.github/workflows/ci.yml` 同步;旧 `test:*` 脚本迁完即删
- **验收**:
  - [ ] `npx vitest run` 全绿,用例数 ≥ 迁移前断言数(不允许静默丢用例)
  - [ ] 单个文件失败不再阻断其余文件执行,CI 汇总展示每文件结果
  - [ ] `package.json` 中 `&&` 串联的 test 脚本消失

**T2 Trace 埋点**
- `src/trace.js` 按 §2 契约实现;`orchestrator.reply()`、`llm.js` 每次 LLM 调用、`retrieve.js` 命中列表各接一行埋点
- token 用量从 API response usage 字段取;单价表进 `params.trace.pricing`(按模型)
- `examples/inspect.js` 增加 trace 查看;本地控制台(UI)加一个只读 trace 页(第二梯队,可延后)
- **验收**:
  - [ ] 试聊 3 轮后 `logs/traces/` 出现 3 条完整 trace,含记忆命中/分段 token/成本/延迟
  - [ ] 埋点全链路 try-catch,人为让 trace 落盘失败(只读目录),回复不受影响,单测覆盖
  - [ ] `trace.dailyCost()` 汇总数与逐条累加一致(单测)

**T3 成本日报**
- 夜间维护(`maintain nightly`)追加:昨日 `dailyCost` 写入 `logs/cost-daily.jsonl`;超过 `params.trace.dailyBudgetUsd` 时 console.warn + UI 显示
- **验收**:
  - [ ] 连续运行两天后 `cost-daily.jsonl` 有两条记录,字段完整
  - [ ] 预算超限告警有单测(注入假 trace 数据触发)

**T4 渐进类型检查(第二梯队)**
- `jsconfig.json` + `// @ts-check` 从 `src/engine/`、`src/state/` 等纯逻辑模块开始;不做 TS 全量迁移
- **验收**:
  - [ ] `npx tsc --noEmit` 进 CI,已标注模块零 error;每月递增覆盖模块数

### E · 评测闭环(核心主线)

**E1 长程记忆基准**
- `bench/memory-bench.cases.json`:五类题各 ≥ 10 题(中文,贴伴侣场景)——
  - `fact` 单事实回忆(3 个 session 前提过的生日/忌口)
  - `update` 偏好更新("以前讨厌香菜后来喜欢",答案必须是新偏好,提旧偏好只能以"变化"口吻)
  - `temporal` 时序推理("面试是搬家之前还是之后")
  - `multi-session` 跨 session 综合("她最近压力大的三个迹象")
  - `abstention` 拒绝幻觉(问从没说过的事,必须承认不知道,编造 = 0 分)
- `bench/run-memory-bench.js`:按 `daysAgo` 用 now 注入灌对话(走真实 `Memory.observe`,`bench_` userId)→ 提问走 `recall` + 回复模型作答 → 规则先判(mustMention/mustNotMention),存疑交 judge 仲裁
- 检索层单独出分:每题标注 gold memory(灌入时记 id),算 recall@5 / recall@10 / MRR
- 结果落 `bench/results/YYYY-MM-DD-memory.json` + 追加进 `docs/bench-history.md`
- **验收**:
  - [ ] `npm run bench:memory` 一条命令跑通,输出五类 accuracy + retrieval 指标
  - [ ] 同一代码连跑两次,overall 波动 ≤ 5 个百分点(判卷稳定性)
  - [ ] 首次基线数字写入 `docs/bench-history.md`(**不设及格线,基线本身就是交付物**)
  - [ ] `npm run bench:clean` 可一键清除所有 `bench_` 数据,清后生产表无残留(SQL 验证)

**E2 对话质量评测(LLM-as-judge)**
- `bench/dialogue.scenarios.json`:≥ 15 个多轮剧本,覆盖 v2 的行为场景(冷落后重逢/吵架修复/提及旧偏好/深夜求安慰/故事线追问)
- `bench/run-dialogue-eval.js`:剧本逐轮喂给真实 Orchestrator(mock 掉投递层,LLM 走真实接口),全对话转录交 judge 按 §2 五维 rubric 打分;judge prompt 里给每维 1/3/5 分的锚点例句
- judge 用独立便宜模型(与被评模型不同源,避免自评偏置);每次运行成本打印在结果里
- **验收**:
  - [ ] `npm run eval:dialogue` 输出五维均分 + overall + 全转录存档
  - [ ] judge 稳定性:同一份转录评两次,各维分差 ≤ 0.5
  - [ ] 人工抽查 5 个剧本,judge 评分与人的排序方向一致(记录在 PR 里)
  - [ ] 基线分数进 `docs/bench-history.md`

**E3 消融实验(v3 的审判日)**
- `params.ablation.*` 开关贯通 §2 列的 7 个机制(大多已有注入口:monologue 是 options、narration/story/world 是依赖注入、moodGating 在 engine 权重、behaviorPolicy 在 orchestrator)
- `bench/run-ablation.js`:E2 剧本 × (全开 + 逐一关闭),生成对照表
- 产出 **`docs/ablation-report.md`**:每机制一行 [开启分 | 关闭分 | Δ | 每轮平均成本差 | 结论:保留/删除/重构],并给出决策
- **验收**:
  - [ ] 报告覆盖全部 7 个机制,每行有数字
  - [ ] Δ ≤ judge 噪声(0.5)的机制,明确写入"删除/重构名单"并建后续任务——**不允许"再观察观察"**
  - [ ] Δ 显著为正的机制,结论和数字同步进 README(这就是项目的技术含量证书)
  - [ ] 本报告发布后,功能冻结(§1 原则 1)解除

### R · 检索升级(用 E1 当裁判)

**R1 双路召回 + RRF 融合**
- `sql/schema.sql` 幂等追加:`memories` 建 pg_trgm GIN 索引(中文无好分词,trgm 对子串匹配足够)+ `match_memories_keyword` RPC
- `retrieve.js`:两路并发召回 → RRF(k=60)融合去重 → 现有 rerank;`params.retrieval.hybrid` 开关,默认关,E1 验证后再默认开
- **验收**:
  - [ ] E1 retrieval 指标对比:hybrid 开 vs 关,recall@5 不降,且 `fact`/`update` 类含专名题(人名/地名/菜名)的命中率提升,数字进 bench-history
  - [ ] 单查询 P95 延迟增幅 ≤ 150ms(trace 数据验证)
  - [ ] 关开关即回滚,无 schema 不兼容

**R2 rerank 升级**
- `params.retrieval.reranker: 'heuristic' | 'llm'`;llm 模式:便宜模型对融合后 top-20 按"与当前对话的相关度"打 0-10 分,与启发式分加权
- **验收**:
  - [ ] E1 上 MRR 提升(数字说话,不达标就保持 heuristic 默认并记录结论)
  - [ ] 每轮新增成本 ≤ $0.001(trace 验证),超了就降采样(仅高难 query 触发)

**R3 激活引擎对决(engine/activation.js 的证明或退役)**
- 把 `engine` 的 ACT-R 激活打分作为第三种 reranker 接入同一开关,在 E1 + E2(情绪相关剧本)上与 R1/R2 对比
- **验收**:
  - [ ] 三种 reranker 同表对比进 bench-history;activation 若无优势,`docs/ablation-report.md` 记录退役结论,代码移入 `attic/`(不删,留研究价值)

### F · 从数据学习(替换拍脑袋)

**F1 标注数据管道**
- `scripts/label-from-traces.js`:从 trace 抽样(脱敏:仅保留状态快照与最近两轮)→ 强模型标注 emotionLabel / importance → 人工抽检 20% → 金标进 `datasets/*.jsonl`(进 git)
- **验收**:
  - [ ] `datasets/emotion-labels.jsonl` ≥ 300 条、`importance-labels.jsonl` ≥ 300 条
  - [ ] 人工抽检一致率 ≥ 90%(否则重标),抽检记录留档

**F2 情绪推断校准**
- 先跑底分:`evalEmotionLabel(dataset)` 测现有 31 行 if/else 的 accuracy + 混淆矩阵(**这个数字本身就有信息量**)
- 迭代手段不限:规则扩充 / 特征 + 最近邻 / 蒸馏小逻辑回归(纯 JS 可跑),但每次改动必须在留出集上验证
- **验收**:
  - [ ] 留出集(20%)accuracy ≥ 85%,混淆矩阵进 bench-history
  - [ ] '委屈' vs '生气'、'撒娇' vs '开心' 两组易混对的 F1 各 ≥ 0.8
  - [ ] E2 情绪类剧本分数不降(校准不能伤害端到端)

**F3 遗忘/重要性参数拟合**
- `fitForgetRate`:用生产 `access_log`(≥ 60 天数据)拟合 ACT-R 衰减指数 d,替换 `params.engine.forgetRate` 拍的值;importance 权重用 F1 标注集回归
- **验收**:
  - [ ] 拟合脚本输出 d 与 r²,r² ≥ 0.6 才替换,否则保留原值并记录"数据不支持"
  - [ ] 替换后 E1 overall 不降

---

## 4. 数据与参数变更

| 变更 | 位置 | 迁移 |
|---|---|---|
| trace JSONL | `logs/traces/`(gitignore) | 无 DB 变更 |
| pg_trgm 索引 + keyword RPC | `sql/schema.sql` 幂等追加 | 重跑 schema.sql 即可 |
| `params.trace.*`(pricing/dailyBudgetUsd) | `src/params.js` | 新增段 |
| `params.retrieval.*`(hybrid/reranker) | `src/params.js` | 新增段,默认保持现状行为 |
| `params.ablation.*` 7 开关 | `src/params.js` | 默认全开(现状行为) |
| `datasets/`、`bench/`、`attic/` 目录 | repo 根 | 新增 |
| `bench_` userId 约定 + 清理脚本 | `bench/clean.js` | — |

---

## 5. 里程碑排期(依赖关系:T1/T2 → E1/E2 → E3 → R/F)

| 周 | 交付 | 里程碑验收 |
|---|---|---|
| W1 | T1 vitest 迁移 + T2 trace 埋点 | `vitest run` 全绿;试聊出完整 trace |
| W2-3 | E1 记忆基准 + E2 对话评测 | 两条 `npm run` 命令出基线数字,写入 bench-history |
| W3 | T3 成本日报 | cost-daily 两天数据 |
| W4 | **E3 消融报告** | `docs/ablation-report.md` 发布,删除名单确定,功能冻结解除 |
| W5-6 | R1/R2/R3 检索对决 | bench-history 有三方对比表,默认配置按数字定 |
| W6-7 | F1 标注集 + F2 情绪校准 | accuracy ≥ 85% 或如实记录未达标原因 |
| W8 | F3 参数拟合 + 收尾 | README 更新 benchmark 表 + 消融表 |

每周里程碑未达即停下修,不带病推进下一周。

---

## 6. 风险与红线

- **judge 不可靠**:rubric 锚点例句 + 双评稳定性验收(≤ 0.5)兜底;仍不稳则换更强 judge 模型,成本上浮记入 T3。
- **评测成本失控**:E1+E2+E3 全量一轮预算上限 $5;`bench:*` 命令启动时打印预估成本,超限拒跑(`--force` 覆盖)。
- **bench 数据污染生产**:`bench_` 前缀是硬约定,`bench/clean.js` + 验收里的 SQL 检查兜底;CI 里 bench 只跑纯逻辑部分,连库的 bench 手动/定时跑。
- **消融结论被感情绑架**:删除名单是机械规则(Δ ≤ 噪声即列入),文档发布前不许改规则。真要保留,唯一途径是补充能证明其价值的新剧本进 E2,重跑。
- **红线(继承)**:`fact_core` 不可变;失败安全降级;既有断言全绿。
- **红线(v3 新增)**:E3 之前功能冻结;无对比数字的优化 PR 不合入。

---

## 7. 总验收标准(v3 Definition of Done)

全部满足才算完成本轮升级:

1. [ ] `npx vitest run` 单命令全绿,CI 同步,无 `&&` 串联
2. [ ] 每轮线上回复可在 trace 中还原:命中记忆、各段 token、成本、延迟
3. [ ] `npm run bench:memory` / `eval:dialogue` / `bench:ablation` 三条命令可复现所有数字
4. [ ] `docs/bench-history.md` 至少包含:首次基线、检索三方对比、情绪校准前后
5. [ ] `docs/ablation-report.md` 覆盖 7 机制,删除名单已执行(代码删除或移入 `attic/`)
6. [ ] README 增加"评测与证据"一节:benchmark 表 + 消融表 + 复现命令
7. [ ] `emotionLabel` 留出集 accuracy ≥ 85%(或有数据支撑的未达标说明)
8. [ ] `params.js` 中 forgetRate/importance 权重要么有拟合来源注释,要么标注"数据不足,沿用默认"
9. [ ] 一轮全量评测成本 ≤ $5,且有账可查
