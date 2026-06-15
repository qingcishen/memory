# Cyber Memory · 开发文档(v0.1 → v1.0)

> **一句话定位**:不是"RAG + 衰减",而是一个**有情绪状态、属于关系、会被重构、面向未来**的活体记忆。
>
> 现存所有记忆系统(含我们 v0.1)的共同假设是 **"记忆 = 忠实的数据库读写"**。这恰恰是最不像人、对伴侣最致命的假设。本项目的全部创新,来自**推翻这个假设**。
>
> 文档原则:每阶段**可独立上线**、**有验收标准**、**改动圈定到文件**。激进路线,但用"事实核不可变"做安全阀。

---

## 0. 现状基线(v0.1 已完成,作为基座)

提取 / 嵌入 / 存储+矛盾 supersede / 加权检索+强化 / 衰减 / 反思 / 遗忘 / 门面类 / SQL schema / 逻辑测试 / demo —— 全部就绪(见各 `src/*.js`)。

v0.1 是个**干净的标准 RAG 记忆**,正是我们要超越的"标准方案"。它的检索、存储管线**复用为基座**,但记忆的**本体模型**要被替换。

---

## 1. 核心理念:活体记忆(本项目的全部创新所在)

### 1.1 一个内核,四个切面

中心是一个**关系-情感状态机**:实时维护「她当下的心情」+「你俩关系的状态」。记忆的**写入、检索、重构、唤起**全部被这个状态调制。四个招牌机制都是它的切面:

```
                 ┌───────────────────────────────────┐
                 │   关系-情感状态机 (AffectiveState)   │
                 │   mood{valence,arousal}             │
                 │   relationship{closeness,tension,    │
                 │                repair_debt,trust}    │
                 └───────────────────────────────────┘
                    │            │            │
        ┌───────────┘            │            └────────────┐
        ▼                        ▼                         ▼
 ③ 心情门控检索           ① 重构性记忆               ④ 预期记忆
 (mood-congruent)        (reconsolidation)          (prospective)
 心情偏置"想起什么"       想起时按当下情绪改写         向未来某刻/某线索开火
        │                        │                         │
        └────────── ② 关系本位:记忆主体是「我们」,不只「用户」 ─────────┘
```

### 1.2 招牌机制①:重构性记忆(reconsolidation)— 最反主流

**人的记忆每次被想起都会被当下情绪悄悄改写**(认知科学叫 memory reconsolidation)。和好后,那次吵架的记忆**自己变软**;她开心时,旧事记得更暖。**过去是活的,不是冻住的。**

- 没有任何 AI 记忆系统做这个——因为大家都把记忆当忠实存储。
- 这是最像人、最有亲密杀伤力的机制。

### 1.3 招牌机制②:关系本位的共同记忆

记忆主体三分:`user`(关于你)/ `self`(关于她自己,即 persona)/ **`dyad`(我们共有的)**。
"我们一起淋的那场雨"不是关于你的事实,是**双方共有、带情感产权的共同记忆**。**以关系而非用户为记忆主体**,没人这么建模。

### 1.4 招牌机制③:心情门控检索(mood-congruent recall)

她"心情不好"时,检索**偏向**调出负面/相关记忆(真人闹脾气翻旧账)。检索结果随**她当下情绪状态漂移**——同样一句话,不同心情下她"想起"的东西不同。

### 1.5 招牌机制④:预期记忆(prospective memory)

"你上次说今天面试,怎么样了?"——她**主动**在未来某刻/某线索把事捞回来。现存系统全是被动回溯,**没有面向未来的记忆**。

### 1.6 安全阀架构:事实核不可变 / 情感层可流动 ★关键

①③ 会让记忆"扭曲",听起来像"AI 不可靠 / 胡说 / PUA"。**解法是把每条记忆劈成两层:**

```
MemoryItem {
  fact_core:  "2024-03 我们在西湖淋了雨"        ← 不可变。扭曲=bug。生日/名字/承诺都在这层
  affect:     { valence, intensity }            ← 可重构。情绪色彩随状态机改写
  narrative:  "那天虽然狼狈,但其实挺浪漫的"      ← 可重构。她对这件事当下的解读
  subject:    user | self | dyad
}
```

**"事实恒定、情感流动"** 本身就是一个没人做过的记忆本体模型,也是这套敢上线的根本保证。**任何机制都禁止改写 `fact_core`。**

---

## 2. 自研检索引擎(基座,承载心情门控)

> 上一轮已定:伴侣是**单用户 10³~10⁴ 条**记忆,自建进程内引擎**既可行又必要**(brute-force 几毫秒;且唯有自建才能把"心情/情绪/扩散"塞进打分)。pgvector 降级为**向量持久化后端**,不再决定"怎么检索"。

**激活打分**(统一 recency/强化/情绪/扩散/**心情门控**):

```
Activation(m, ctx) =  B(m)                       基础: ACT-R base-level = ln(Σ tₖ⁻ᵈ)  (新近+频次)
                   +  wCtx · Sim(m, ctx)         语境相似
                   +  Spread(m)                  联想扩散(沿 memory graph)
                   +  wMood · MoodCongruence(m, state)   ③ 心情门控:与当前情绪同向的记忆被点亮
                   +  wMile · Milestone(m)       关系里程碑常驻
                   -  Temporal_penalty(m)        过期情节降权(不归零)
```

`MoodCongruence` = 记忆 `affect.valence` 与状态机 `mood.valence` 的一致度。这是 SQL 永远做不到、必须自研的点。

---

## 3. 分阶段计划(激进全量路线)

> 关系:**M0→M1→M2 是关键路径**(本体模型 → 状态机 → 门控引擎),之后 M3/M4/M5 可并行,M6/M7 收尾。

### M0 · 安全地基:两层记忆本体 + 关系主体

**做的是 1.6 + 1.3 的数据基础。先不改行为,但下游全依赖它。**

**Schema** (`sql/schema.sql`)
```sql
alter table memories add column if not exists fact_core      text;        -- 不可变事实核(迁移期=content)
alter table memories add column if not exists affect_valence real default 0;   -- -1..1 可重构
alter table memories add column if not exists affect_intensity real default 0; -- 0..1 可重构
alter table memories add column if not exists narrative      text;        -- 她当下的解读, 可重构
alter table memories add column if not exists subject_kind   text default 'user'; -- user/self/dyad
alter table memories add column if not exists reconsolidation_count int default 0;
alter table memories add column if not exists access_log     jsonb default '[]'::jsonb; -- 历次唤起时间, 给 base-level
```

**提取层** (`src/extract.js`):输出 `fact_core` / 初始 `affect` / `subject_kind`(区分"关于你/她自己/我们")

**门面**:写入与读取都带新字段;旧 `content` 暂保留为兼容视图

**验收**
- [x] 提取一段对话,正确分出 fact_core 与 affect,且 dyad 记忆被识别("我们一起…")
- [x] **不变式测试:任何写路径都不改已存在记忆的 `fact_core`**(锁定测试,见 `examples/ontology.test.js` `assertFactCorePreserved`)

---

### M1 · 关系-情感状态机(心脏)

**新模块** `src/state/affect.js`
- `readState(userId)` / `writeState(userId, state)`:存取当前 mood + relationship
- `updateFromTurn(userId, turns)`:从本轮对话**推断情绪与关系增量**(LLM 低频 + 启发式),如吵架→`tension↑ repair_debt↑`,和好→`repair_debt→0 closeness↑`
- `decayToBaseline(userId, now)`:心情随时间回落基线(情绪不会永远停在峰值)

**Schema**(新表)
```sql
create table if not exists affective_state (
  user_id text primary key,
  mood jsonb not null default '{"valence":0,"arousal":0.3}',
  relationship jsonb not null default '{"closeness":0.5,"tension":0,"repair_debt":0,"trust":0.5}',
  updated_at timestamptz default now()
);
```

**集成** (`memory.js`):`observe` 后更新状态;`recall` 前读状态供门控/重构用

**验收**
- [x] 模拟"吵架"轮次后 `tension/repair_debt` 上升;"和好"轮次后回落、`closeness` 升 — `examples/state.test.js`
- [x] 无新输入时,mood 随时间向基线衰减(纯逻辑单测)— `decayState` + 半衰期断言

> **已实现** (`src/state/affect.js` + 表 `affective_state` + `examples/state.test.js`, 29 断言):
> 纯逻辑(`defaultState/clampState/decayState/applyDeltas/inferHeuristicDeltas/moodLabel`)与 IO(`readState/writeState/updateFromTurn/decayToBaseline` + 低频 `inferDeltasLLM`)分层。
> 心情按半衰期回落基线;关系字段黏着(closeness/trust/repair_debt 不随时间动,tension 缓和得慢);`maxStepPerTurn` 保证一句话推不爆状态。`memory.js` 的 `observe` 已先更新状态,并新增 `state()/mood()/settle()`。

---

### M2 · 自研引擎 + 心情门控检索(招牌③)

**新模块** `src/engine/`:`vector-index.js`(进程内 brute-force/HNSW,按 modality 分桶)+ `activation.js`(§2 激活函数,纯逻辑)+ `graph.js`(联想扩散)+ `index.js`(门面)

- 复刻旧检索后,把 `MoodCongruence` 接入激活:状态机 mood 偏置"想起什么"
- 与旧 pgvector 路径**双轨对照**,验证不退化再切默认

**参数** (`src/params.js`):`forgetRate, wCtx, wMood, wMile, temporalPenalty, graphHops, graphDecay`

**验收**
- [x] 同一 query,在"她开心"vs"她受伤"两种状态下,recall 出的记忆集合**显著不同**(负向记忆在受伤态被点亮)— `examples/engine.test.js`
- [x] 关闭门控(wMood=0)时退化为标准激活,与旧路径一致 — 同上,两态顺序一致
- [x] 万级记忆 recall < 20ms;引擎纯逻辑单测齐全 — 10k 条 ~9ms

> **已实现** (`src/engine/{activation,vector-index,graph,index}.js` + `examples/engine.test.js`, 24 断言):
> `activation.js` 纯逻辑实现 §2 激活函数(ACT-R base-level + 语境相似 + 扩散 + **心情门控** + 里程碑 − 过期降权);`vector-index.js` 进程内 brute-force 余弦索引(按 modality 分桶,为 M6 预留);`graph.js` 相似图 kNN + 有界联想扩散;`index.js` 门面 `rankCandidates`(纯)/`engineRecall`(IO)。`match_memories` 增回 `embedding` 列供进程内扩散。`memory.js` 的 `recall` 默认走引擎并读 M1 状态做门控,`{ engine:false }` 可退回旧 pgvector 重排路径(双轨对照)。

---

### M3 · 重构性记忆(招牌①,本项目灵魂)

**新模块** `src/memory/reconsolidate.js`
- `reconsolidate(recalledMems, state, opts)`:被唤起的记忆,其 `affect_valence/intensity` 向**当前状态**轻微靠拢(有界、有阻尼);`narrative` 在情绪显著变化时由 LLM 低频重写
- **铁律**:只改 affect/narrative,**绝不碰 fact_core**;每次 `reconsolidation_count++`
- 触发点:① recall 命中时(轻量,纯数值)② 每晚 reflect 时(可含 narrative 重写)

**反思层** (`reflect.js`):和好后批量"软化"高 tension 旧记忆;开心期整体上调旧记忆暖度(有上限,防失真)

**参数**:`reconsolidationRate`(靠拢步长)、`affectClamp`(单次最大漂移)、`factCoreLocked: true`(硬开关)

**验收**
- [x] 录入一条"吵架"负向记忆 → 模拟和好(状态机 repair) → 多次 recall 后该记忆 `affect_valence` 明显回暖,**但 fact_core 一字未变** — `examples/reconsolidate.test.js`
- [x] 漂移有界:单次不超过 `affectClamp`;`factCoreLocked` 关不掉 fact_core 保护
- [x] 纯逻辑单测覆盖靠拢/夹紧/不变式 — 15 断言

> **已实现** (`src/memory/reconsolidate.js` + `examples/reconsolidate.test.js`, 15 断言):
> 所有漂移走 `ontology.applyAffectUpdate` 单点入口 + 每次 `assertFactCorePreserved` 自检, fact_core 红线即使被改也立刻抛。`reconsolidate()` 纯逻辑: 被唤起记忆的 valence/intensity 朝当下 mood 有界靠拢; `reconsolidateOnRecall` (recall 命中时轻量染色, 落库异步) + `reconsolidateRecent` (和好后/夜间批量软化, 可选 LLM 重写 narrative)。`memory.js` 的 `recall` 默认带 onRecall 染色, 新增 `mem.reconsolidate()`。

---

### M4 · 共同记忆与关系叙事(招牌② + persona 合并)

**做的是 1.3:`subject_kind` 三分的产品化。**
- **dyad 记忆**:recall 时可"无条件带 1~2 条最重要的我们共同记忆"作为关系底色(参数 `alwaysIncludeDyad`)
- **self 记忆 = persona**:她对自己的连续设定并入 `subject_kind='self'`,`src/persona.js` 提供 `seed/capture/personaBlock`,域隔离(self 不被 user 记忆污染)
- **关系叙事** `src/narrative.js`:定期把 dyad 记忆 + 状态历史**合成一段"我们的故事"**(narrative identity),作为最高层 reflection 存回

**验收**
- [x] "我们一起…"被存为 dyad 且能稳定作为关系底色注入 — `pickDyadBackdrop` + `recall` 无条件补底色
- [x] 她说"我有点社恐"被存为 self,下次注入且不被 user 记忆覆盖 — `filterBySubject` 域隔离 + `personaBlock`
- [x] narrative 合成产出连贯的关系故事(人评)— `synthesizeNarrative`(LLM,人评);`composeNarrativeInput` 拼装已单测

> **已实现** (`src/persona.js` + `src/narrative.js` + `examples/relationship.test.js`, 14 断言):
> 三分主体 user/self/dyad。`recall` 默认域隔离到 `['user','dyad']`(self 不污染"关于你"的检索),并无条件补 `alwaysIncludeDyad` 条最重要 dyad 记忆作关系底色。persona: `seedPersona`/`personaBlock`(只取 self)。关系叙事: `synthesizeNarrative` 把 dyad 记忆+状态合成"我们的故事"存为最高层 reflection。facade 新增 `seedPersona/persona/story`。

---

### M5 · 预期记忆(招牌④)

**Schema**(新表)
```sql
create table if not exists prospective (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  content text not null,                 -- "问问他面试结果"
  trigger_kind text not null,            -- time / cue
  trigger_at timestamptz,                -- time 型: 触发时刻
  cue_embedding vector(1536),            -- cue 型: 语境线索向量
  status text default 'pending',         -- pending / fired / cancelled
  created_at timestamptz default now()
);
```

**新模块** `src/memory/prospective.js`
- `schedule(...)`:提取阶段识别"未来意图"("我明天面试")→ 自动排一个 time 触发
- `due(userId, ctx, now)`:每轮/定时检查到期或语境命中的预期记忆,交给回复层主动提起
- 触发后置 `fired`;过期未提的降级或丢弃

**集成**:`recall` 顺带返回 `dueProspectives`;门面暴露 `mem.checkProspective(ctx)`

**验收**
- [x] "我明天有面试"→ 自动排程;到次日 recall 时返回"问面试结果"的预期项 — `detectProspective`+`isDue`
- [x] cue 型:用户再提相关话题时被语境触发 — `isDue` cue 分支 (cue_embedding 余弦)
- [x] 已 fired / 过期 不重复打扰 — `isDue` 看 status + `isExpired` grace 降级

> **已实现** (`src/memory/prospective.js` + 表 `prospective` + `examples/prospective.test.js`, 20 断言):
> 纯逻辑 `relativeTriggerAt`(明天/今晚/待会→绝对时刻)、`detectProspective`(未来时间词+值得关心的事件才记)、`isDue`(time 看时刻 / cue 看语境余弦)、`isExpired`(grace 后降级)。IO `scheduleFromTurns`(observe 顺手排程)、`dueProspectives`(先扫过期再返回 due)、`markFired`。facade: `observe` 返回 `scheduled`,新增 `checkProspective/dismissProspective`。

---

### M6 · 多模态记忆(图片 + 语音)

**Schema**:`modality text default 'text'`、`media_embedding vector(512)`、`media_ref text`

**新模块** `src/modal/`:`ingestImage`(vision caption + CLIP 向量)/ `ingestAudio`(ASR 转写 + 语气→affect)。统一产出带双向量的 MemoryItem,复用 M0~M3 的本体/状态/重构/引擎(图片记忆同样会被情绪重构、参与门控)

**验收**
- [x] 发图→caption 入库 (modality=image),进 content/embedding 可被文本召回 — `buildImageMemory`
- [x] 发语音→转写进 content 且语气进 affect (哭着说"没事" vs 笑着说 affect 不同) — `prosodyToAffect`/`buildAudioMemory`
- [x] 缺凭证降级纯文本不崩 — `ingestImage/ingestAudio` 无输入返回 `[]`,不抛
- [x] 图搜图: 按 `media_embedding` 余弦相似度召回 — `rankByMediaSimilarity`/`recallMedia` (#6 工程债)

> **已实现** (`src/modal/{image,audio,index}.js` + schema `modality/media_embedding/media_ref` + `examples/modal.test.js`, 29 断言):
> 图片走 vision caption → image 记忆 (caption 进文本召回, 可选 CLIP `media_embedding`);语音走 ASR 转写 + 语气→affect。统一复用 M0~M3 本体/状态/重构/引擎 (`ontology.normalizeMemory`/`store` 已加 modality/media 字段,`VectorIndex` 早已按 modality 分桶)。facade 新增 `seeImage/hearVoice`,缺凭证全程降级不崩。
> **媒体向量闭环** (#6 工程债,✅ 已补): `rankByMediaSimilarity` 纯逻辑按 `media_embedding` 余弦相似度排序 (跳过没存向量的候选), `recallMedia(userId, queryEmbedding, opts)` 拉该用户带 `media_embedding` 的记忆做进程内 brute-force 排序 + 强化 (同 M2 VectorIndex 思路, 省一次 SQL 函数)。本项目不内置视觉 embedding 模型 —— `queryEmbedding` 由调用方用 CLIP 等模型算好传入。facade 暴露为 `Memory.recallMedia(queryEmbedding, opts)`。`PARAMS.modal.mediaTopK` 控制默认返回条数。

---

### M7 · 工程化 & 成本控制

去重(`dedup_hash`+近邻,重复则强化写 `access_log`)/ 降 LLM 调用(矛盾判断合批、`observe` 异步)/ `VectorIndex` 暴力→HNSW / `npm run inspect <userId>`(打印记忆+状态+边+激活+预期)。

> **已实现** (`src/dedup.js` + `examples/inspect.js` + `examples/dedup.test.js`, 9 断言):
> - [x] 去重: `dedupHash` 规范化指纹(去标点/空白/大小写),`store.storeMemories` 先按指纹命中已存记忆 → 强化(`access_count++`/`access_log` 追加)而非新增;新增列 `dedup_hash` + 部分索引。
> - [x] `npm run inspect <userId>`: 打印关系-情感状态 + 记忆(按主体分组、带激活明细 B/mood/mile)+ 待触发预期记忆。
> - [x] 合批: 矛盾判断 `judgeContradictions` 本就整批送一次 LLM;去重把"反复说同一件事"挡在 embedding/插入之前,省调用。
> - HNSW 按计划**后置**:单用户 10³~10⁴ 条,`VectorIndex` brute-force 实测 10k 条 ~9ms(M2),暂不需要。

---

## 3.5 诚实缺口与下一轮修复队列

M0-M7 打通后,系统已经有"像人"的骨架,但还有几处卖点与实现之间的落差。这里把它们作为 v1.1 修复队列,避免文档只报喜。

### P0 · 直接影响核心承诺

1. **翻旧账检索**:已补第一刀。普通 `recall` 继续只取 `superseded_by is null` 的当前事实;新增 `retrieveSupersededTrail` / `Memory.recallHistory()` / `Memory.recallHistoryAsPrompt()` 显式沿 superseded 链捞旧版本。这样"你以前不是讨厌香菜吗"有数据路径,但不会污染日常事实回答。SQL 同步新增 `match_memory_history` 作为包含历史版本的辅助检索函数。
2. **状态历史表**:✅ 已补 (`feature/state-history`)。新增 `affective_state_history` 表;`updateFromTurn` 在状态变化总幅度 ≥ `state.snapshotMinDelta` 时追加一条快照,并用 `labelStateEvent` 贴事件标签(吵架/和好/变亲密…)。纯逻辑 `stateDelta`/`summarizeTrajectory`/`formatTrajectory` 概括走向(亲密/信任趋势、紧张峰值、和好次数),`composeNarrativeInput` 与 `synthesizeNarrative` 已读取轨迹,`Memory.stateHistory()` 暴露查询。M1 测试 +14(29→43)。
3. **情感锚回弹**:✅ 已补 (`feature/affect-origin-anchor`)。`memories` 增加不可变的 `affect_origin_valence/intensity`(诞生时写入,像 fact_core 一样不再改)。重构时目标 = 当下心情与原始锚的加权(`originPull`),且结果硬夹在「距锚 ±`maxDriftFromOrigin`」内 —— 长期负面 mood 反复 recall 也洗不黑一条本来温暖的记忆。纯逻辑 `anchorTarget`/`clampToOrigin`/`driftFromOrigin`(漂移审计,已接入 `inspect`);`match_memories` 回传 origin 供 recall 命中时回弹。M3 测试 +14(15→29)。

### P1 · 认知质量

4. **不确定性表达**:✅ 已补。新增 `src/confidence.js`:`memoryConfidence` 把 similarity(查询相关度,缺失按中性 0.5)+ recency/强化(`decay.recencyScore`,缺 `last_accessed` 按 1)按 `confidence.weights` 加权,命中 `detectConflicts`(同批候选里 embedding 余弦相似度 ≥ `confidence.conflict.similarityThreshold` 但 `affect_valence` 符号相反且差值 ≥ `conflict.valenceGap`,即"同一件事但当时感受截然相反")再扣 `conflictPenalty`;低于 `confidence.lowThreshold` 标记 `_lowConfidence`。`Memory.recall()` 统一在引擎/双轨/dyad-backdrop 三路结果上调用 `attachConfidence`;`formatForPrompt` 据此把"- XXX"改成"- 我记得好像XXX"。新增 `examples/confidence.test.js`(20 断言,全局 365→385)。
5. **情绪指向性**:✅ 已补。`affective_state.relationship` 增 `tension_target`(user/external)+ `tension_topic`(启发式 `detectTensionTarget` + LLM 双产出,仅 tension 上升时采纳、缓和回基线后清空)。消费三处:`emotion.moodToEmotion` 在指向外部时按 `externalTensionWarmthFactor` 弱化对用户 warmth 的拉冷;`formatRelationshipPrompt` 措辞区分"为外部事烦"vs"对你有情绪";`engine/activation.directedMoodCongruence` 用话题向量做定向门控,只点亮与紧张话题语义相关的负面记忆,缺话题/指向用户时退化为全局门控(回归安全)。state/emotion/engine 测试 +多条。
6. **媒体向量闭环**:✅ 已补。`src/modal/image.js` 新增 `rankByMediaSimilarity`(纯逻辑,余弦排序,跳过没存 `media_embedding` 的候选)与 `recallMedia(userId, queryEmbedding, opts)`(IO,拉该用户带 `media_embedding` 的记忆做进程内排序 + 强化,同 M2 VectorIndex 思路)。`queryEmbedding` 由调用方用 CLIP 等模型算好传入,本项目不内置视觉 embedding 模型。`PARAMS.modal.mediaTopK` 控制默认条数,facade 暴露为 `Memory.recallMedia(queryEmbedding, opts)`。M6 测试 +11(18→29)。

### P2 · 工程与安全债

7. **observe 异步化**:✅ 已补。`Memory.observe` 里互不依赖的状态更新 (`updateFromTurn`)、记忆提取 (`extractMemories`)、M5 预期记忆排程 (`scheduleFromTurns`) 改为 `Promise.all` 并发执行,各自 `.catch` 做失败隔离(任一失败退化为空结果,不拖垮其它两路);落库 (依赖提取结果 + 心情位移加成) 仍在并发结果之后顺序执行。
8. **近义去重**:✅ 已补。`storeMemories` 插入前先用新记忆的 embedding 查 `match_memories`,候选相似度 ≥ `dedup.nearDuplicateThreshold`(默认 0.96,明显高于矛盾判断的 0.82)就视为"同一件事换了说法"(如"讨厌香菜"/"不爱吃香菜"),强化命中的旧记忆而非新增;这批候选随后复用于矛盾检测,不再多查一次。纯逻辑 `dedup.isNearDuplicate`/`findNearDuplicate`。M7 测试 +7(9→16)。
9. **主动遗忘与 prompt 注入防护**:✅ 已补。新增 `src/promptSafety.js`:`looksLikeInjection` 用正则启发式识别"忽略以上指令"/"ignore previous instructions"/伪造 `system:`/`###` 角色头与标题(含换行后藏的);`sanitizeForPrompt` 先在原文上判断注入(命中则整条替换为占位串 `[内容含可疑指令片段, 已过滤]`),否则折叠空白/换行,接入 `formatForPrompt`/`formatSupersededTrailForPrompt`(retrieve.js)与 `formatPersonaBlock`(persona.js)。新增 `forget.similarityThreshold`(默认 0.75,低于矛盾判断的 0.82)+ `selectForgettable`/`forgetByQuery`(reflect.js,纯逻辑部分可单测),`fact_locked` 默认不删,暴露为 `Memory.forget(query, opts)`。新增 `examples/safety.test.js`(独立 Safety 套件,25 断言,全局 340→365)。
10. **事务与并发写入**:✅ 已补(常见情形)。`memories_dedup_unique_idx`(`(user_id, dedup_hash)`,`dedup_hash is not null and superseded_by is null`,唯一)防止两个并发 `observe()` 都在 `fetchByHashes` 里没看到对方、都判定 fresh 而重复插入同一指纹:后到的 insert 抛 `23505`,`store.js` 捕获后用 `resolveInsertConflict` 退化为强化先到的那条(乐观重试),不再抛错丢掉整轮提取。`supersedeContradictions` 的更新加 `.is('superseded_by', null)`,两个并发新记忆都想取代同一条旧记忆时, 先到的生效、后到的影响 0 行, 取代链不会被乱序覆写。新增 `examples/store.test.js`(Concurrency 套件, 9 断言,全局 410→419)。**仍是已知残余**:近义去重(embedding 相似度)路径上的并发竞争未加锁, 极端时序下可能短暂出现两条"当前事实", 留给下一轮近义去重清理。
11. **端到端场景评测**:✅ 已补。新增 `examples/scenario.test.js`(纯逻辑, 不连网): 用 `inferHeuristicDeltas`/`applyDeltas` 推演 5 轮对话(吵架→和好→升温)的真实状态轨迹, `summarizeTrajectory`/`formatTrajectory` 概括走向; 用 `moodShiftMagnitude` + `applyMoodShiftBoost` 验证"吵架的那一轮"记忆 importance 被加成(emotion-design.md §8); 同一份候选记忆池在轨迹的"受伤态"与"升温后"两个时间点分别跑 `rankCandidates`(M2 引擎,心情门控)与 `rerank`(旧 pgvector 路径,不感知心情)——断言引擎召回集合随轨迹漂移(吵架记忆 → 温馨记忆), 而旧路径不漂移, 把 §3 提到的"双轨对照"从"可切换"坐实成实际断言; 最后用一对同话题情绪相反的记忆验证 `attachConfidence`(#4)标记 `_lowConfidence` 并在 `formatForPrompt` 里改口"我记得好像"。Scenario 套件 19 断言, 全局 419→438。

**建议顺序**:先完成 P0 的 #2 状态历史表与 #3 情感锚,因为它们会同时增强"我们的故事"和重构稳定性;随后补 #7/#9 处理延迟与安全。#6/#8 属于半成品闭环,可穿插完成。

---

## 4. 里程碑与排期

| 里程碑 | 阶段 | 价值 | 粗估 |
|---|---|---|---|
| **本体地基** | M0 | 两层记忆+关系主体(创新与安全的根) | 2~3 天 |
| **心脏** | M1 | 关系-情感状态机 | 2~3 天 |
| **门控引擎** | M2 | 自研引擎 + 招牌③ | 3~4 天 |
| **灵魂** | M3 | 重构性记忆 招牌① | 3~4 天 |
| **关系本位** | M4 | 共同记忆+叙事+persona 招牌② | 2~3 天 |
| **向未来** | M5 | 预期记忆 招牌④ | 2 天 |
| **能看能听** | M6 | 多模态 | 3~4 天 |
| **能上量** | M7 | 工程债 | 2~3 天 |

> **关键路径 M0→M1→M2→M3 必须按序**(本体→状态→门控→重构,层层依赖)。M4/M5 可在 M3 后并行。M6/M7 收尾。
> **强烈建议**:先把 **M0~M3** 打通拿到"她的记忆会随情绪重构、随心情漂移"的真实手感,这是整个项目成立与否的验证点。手感对了再投 M4~M7。

---

## 5. 评测策略(激进路线尤其重要)

会"扭曲记忆"的系统最难评测——必须证明它**像人但不失控**:

- **不变式(红线,必须 100% 通过)**:任何机制下 `fact_core` 永不改变;生日/名字/承诺等被标 `locked` 的记忆零漂移。CI 强制。
- **有界性**:affect 漂移单次/累计不超阈值;反复 recall 不会把记忆"洗"成完全相反(防失真)。逻辑层固化。
- **状态因果**:吵架→tension↑、和好→回暖,可复现的状态机断言。
- **"像人"主观评测**:小样本人评 recall 的"心情一致性""过去是活的"体感(无法自动化,定期人评)。
- **回归**:旧 `recallAsPrompt(query)→string` 用法永不破坏;引擎 vs pgvector 不退化。

---

## 6. 风险与取舍(激进路线已知雷区)

| 风险 | 说明 | 对策 |
|---|---|---|
| 记忆"扭曲"被当成 AI 不可靠 | 用户感到被 gaslight | fact_core 绝对不可变;只动情感/解读层;漂移有界+可观测 |
| 重构失真累积 | 反复 recall 把记忆洗反 | `affectClamp` 单次上限 + 向基线的阻尼,非无限累加 |
| 状态机调出"怪性格" | 参数多,易失衡 | 每次 recall/observe 输出状态+激活明细;inspect 工具;关键不变式固化 |
| 评测困难 | 没有现成 benchmark | §5:红线自动化 + 主观人评分离 |
| 自建引擎正确性/性能 | 自己实现可能有 bug | 先 brute-force + 引擎vs pgvector 回归;HNSW 后置 |
| 成本/延迟 | 状态推断、重构、多模态都要 LLM | 数值部分纯本地;LLM 部分低频/异步/采样;缺凭证降级 |

---

## 7. 不做什么(明确划界)

- ❌ 不改 `fact_core` 的任何机制——这是红线,不是功能
- ❌ 不引入独立图数据库(Neo4j):Postgres 邻接表 + 进程内扩散足够
- ❌ 不自研 embedding/CLIP/ASR 模型:自研的是**记忆本体 + 检索引擎 + 认知机制**,不是表征模型
- ❌ 不做工业级分布式 ANN:单用户小规模,进程内即可
- ❌ 不做实时视频/具身视觉:多模态本期到图片+语音
- ❌ 不做跨用户记忆共享:隐私边界,按 userId 严格隔离
