# AI 伴侣系统 · 开发设计方案

> 把整体方案落成可执行的开发计划:开发顺序、阶段任务、验收标准、第一步实操、关键决策。配套文档:[编排器设计方案](orchestrator-design.md)、[情绪系统设计方案](emotion-design.md)、[外貌与生命状态系统设计](appearance-life-design.md)、[Cyber Memory 开发文档](DEVELOPMENT.md)(记忆引擎本体的架构与路线图)。
>
> **v2 更新**:补入外貌系统与生命状态系统;采纳"统一状态层"架构——`energy` 从情绪迁到生理侧,情绪做成状态层的一个维度而非孤立子系统(避免后续返工)。受影响章节:2、3、5、6、8。

---

## 1. 三条开发原则

1. **契约先行。** 动手写任何子系统前,先把门面接口签名冻结(见第 3 节)。接口定死,子系统内部随便写、可并行写。这是你能用多终端并行开发的前提。
2. **垂直切片,不要水平铺。** 每个里程碑都是一条**端到端能跑通**的细线(从 API 到回复),而不是"先把所有子系统都写完再集成"。每一步都能发消息验证,错了立刻发现。
3. **先单进程、先单用户、先无 UI。** 用 REST + curl 跑通后端核心,再上 iOS;先把你自己一个用户跑顺,再考虑多用户。别在 M0 就纠结部署和界面。

---

## 2. 开发顺序总览

**主线(对话能力)**:

| 阶段 | 一句话目标 | 端到端可验证 |
|---|---|---|
| **M0** | 能聊 + 她记得事 | 发消息 → 带检索记忆的回复 |
| **M1** | 记住对话 | 聊完自动提取,下次能引用 |
| **M2** | 有状态(心情) | 跨对话情绪起伏,看得出来 |
| **M3** | 更像人 | 内心独白 + 关系阶段 |
| **M4** | 会主动 | 她按作息/想念主动找你 |
| **M5** | 扛量 | 队列 + 监控 + 成本优化 |

**扩展线(身体与外观,挂在 M2 之后)**:

| 阶段 | 一句话目标 | 端到端可验证 |
|---|---|---|
| **L1~L4** | 有身体、有生活 | 深夜蔫/会生病/有自己的一天(详见[外貌与生命状态系统设计](appearance-life-design.md)第七部分) |
| **A1~A2** | 有样子 | 发一致的、反映此刻状态的自拍 |

> ⚠️ **关键调整(v2)**:M2 别把情绪写成一个孤立的 `emotion` 子系统。既然情绪/身体/生活是同一个模式,**M2 就直接落一个 `StateLayer` 抽象,情绪是它的第一个维度**。这样 L1~L4 加身体/生活维度时是"往状态层插维度",而不是回头重构。现在多花半天定抽象,后面省几天返工。

下面把 M0 展开到可动手级别,其余给任务清单和验收。

---

## 3. 第 0 步:冻结接口契约

开发前先把这些写成空壳(方法存在、返回假数据),让编排器能先跑起来,各子系统之后填实现:

```
// 编排器
orchestrator.reply(userMessage) -> Promise<string>

// 门面(每个子系统只暴露这些)
persona.toPrompt() -> string
persona.name -> string

memory.recall(query, opts?) -> Promise<string>     // 返回注入用记忆块
memory.observe(turns) -> Promise<void>

// 状态层: 情绪/身体/生活统一在这一个门面后面(编排器只对接它)
stateLayer.snapshot() -> Promise<Snapshot>          // 一次拿全部维度当前值
stateLayer.toPrompt(snapshot) -> string             // 所有维度的表现指引合并
stateLayer.samplingHints(snapshot) -> { temperature, maxTokens }
stateLayer.evolve(turns) -> Promise<void>           // 后台一次性演变全部维度

//   状态层内部的维度(各自实现同一接口, 对编排器不可见):
//   - emotion 维度: valence(效价) + warmth(对你的温度)   ← energy 已移走
//   - life   维度: energy(精力) + satiety(饱腹) + health(健康) + 作息/活动
//   M2 先只放 emotion 维度; L1~L4 往状态层里加 life 维度。

relationship.current() -> Promise<State>
relationship.bump() -> Promise<void>
relationship.toPrompt(state) -> string

// 外貌(独立系统, 图像生成技术栈)
appearance.shouldSendSelfie(context) -> bool
appearance.selfie(snapshot) -> Promise<imageUrl>    // 优先查库, 缺则后台生成

// LLM 封装
llm.generateReply(messages) -> Promise<string>
llm.think(context) -> Promise<string>
```

**冻结之后,这几个子系统就能并行开发**——每个终端/每个分支负责一个,只要不碰别人的门面签名,合并时不会打架。你那套多终端并行正好用在这。

> 注意契约层面的两个变化:① 编排器不再直接对接 `emotion`,而是对接 `stateLayer`(情绪是它内部的一个维度)。② 情绪维度去掉了 `energy`,只留 `valence + warmth`;`energy` 归到 `life` 维度。这样后面加身体维度时,编排器侧一行不用动。

---

## 4. M0 最小闭环(展开到可动手)

**目标**:发一条消息,她带着从记忆里检索到的事实回复。只包含:API + 编排器 + 人格 + 记忆检索 + 回复生成。**不含**情绪、关系、独白、客户端 UI。

**任务序列**:

1. **建工程骨架**:monorepo,`apps/api`(Express)+ 引入你的 `memory` 包。装 Supabase 在 SQL Editor 跑记忆表(你已有)。
2. **LLM 封装** `llm.js`:`generateReply`(好模型)+ `think`(便宜模型,M0 可先不接)。两套模型走环境变量。
3. **人格** `persona.js`:返回可可的人格段(性格 + 喜好 + 说话习惯)。纯静态,最简单,先做它找手感。
4. **空壳子系统**:`stateLayer` / `relationship` 先写空壳——`snapshot()` 返回基线、`toPrompt()` 返回空串。让编排器能跑,M2/M3 再填。
5. **编排器** `orchestrator.js`:实现 `reply()` 同步路径,但只接 `persona.toPrompt()` + `memory.recall()` + `generateReply()`。先不接 `observe`(M1 再加)。
6. **API 端点**:`POST /chat { userId, message }` → `orchestrator.reply()` → 返回回复。
7. **手动塞两条记忆**进库(比如"诗雅讨厌香菜""诗雅在日本备考"),用 curl 测。

**验收标准**:

```
curl -X POST /chat -d '{"userId":"me","message":"今晚吃啥好"}'
→ 回复里自然避开香菜 / 提到备考。说明记忆检索 + 注入 + 生成整条链路通了。
```

M0 通了,整个系统的"主干"就立起来了,后面都是往这根主干上插子系统。

---

## 5. M1 ~ M4 任务清单

**M1 记住对话**
- 编排器 `afterReply` 接 `memory.observe(turns)`,fire-and-forget
- 加短期历史(先内存版,`messages` 表入库可留到后面)
- 验收:聊到某个新事实,隔一轮后她能引用 → 提取+写入通了

**M2 状态层 + 情绪维度**(照[情绪系统设计方案](emotion-design.md))
- **先落 `StateLayer` 抽象**:统一的 `snapshot()` / `toPrompt()` / `samplingHints()` / `evolve()`,内部按维度组织
- 第一个维度 = 情绪:`emotion` 表(双层:基线 + 即时),`valence + warmth` 两维(`energy` 留给 L 阶段的 life 维度)
- 维度逻辑:衰减读取 / 增量+阻尼更新 / `toPrompt` 表现指引
- 编排器:`stateLayer.snapshot()` 进同步组装,`evolve()` 进 `afterReply`,`samplingHints` 调采样
- 验收:故意冷落她几轮,她语气变化;过一段时间回基线 → 情绪闭环成立。**且此时往状态层加新维度的口子已经留好。**

**M3 拟人增强**
- 内心独白:编排器接 `llm.think()`,结果注入 system
- 关系:建 `relationship` 表,`bump()` 进 `afterReply`,`toPrompt()` 进组装
- 验收:回复明显有"想法";互动多了称呼/语气变亲密

**M4 主动性**
- `scheduler` 进程(node-cron 起步)
- `proactivity.tick()`:查作息/距上次时长/想念阈值 → 该主动则用 `assemble()` 组装开场 → 推送(iOS APNs / Web Push)
- 验收:隔一段没聊,她主动发来一条且符合人设

**L1~L4 生命状态**(挂在 M2 之后,照[外貌与生命状态系统设计](appearance-life-design.md))
- L1:把情绪并入 `StateLayer`,`energy` 迁到生理侧(若 M2 已按状态层写,这步几乎免费)
- L2:加 `life` 表与维度——energy/satiety/health + 作息曲线 + 影响回复
- L3:生活模拟(作息活动模板,她会提及在做什么),喂主动性
- L4:健康/生病(触发+恢复+被照顾闭环),事件进记忆成共同回忆
- 验收:深夜她蔫、白天精神、会生病、被你照顾会好转更亲密

**A1~A2 外貌**(投入大,放体验跑通后)
- A1:SD + 形象模板 + IP-Adapter + 图库(Supabase Storage),能发一致自拍
- A2:角色 LoRA 锁脸 + 自拍按状态层快照修饰(生病憔悴/健身后/心情好)
- 验收:自拍脸稳定、且反映此刻状态;自拍被关系/情绪/情境触发而非随机

---

## 6. 必须先拍板的决策

开工前定这几个,免得返工:

| 决策 | 建议 |
|---|---|
| 客户端先做什么 | **先 REST + curl 跑通后端**,iOS 放到 M2 之后再上 |
| 回复模型 | 好模型(Anthropic 类);后台一律 DeepSeek |
| LLM 接入 | 走 OpenRouter 统一路由(你熟,容灾+比价),或直连 |
| 鉴权 | Supabase Auth,M0 可先硬编一个 userId 跳过 |
| 区域/代理 | 你有过 Antigravity 的区域问题,先确认部署环境能稳定访问回复模型 API |
| 多用户 | M0~M4 单用户(你自己),M5 再考虑隔离与限流 |
| 状态层抽象 | **M2 就按 `StateLayer` 写,energy 归生理侧**;别先写孤立 emotion 再重构 |
| 图像技术栈 | A 阶段定:SD + IP-Adapter 起步 → 角色 LoRA 锁脸;ComfyUI API 化;图存 Supabase Storage |

---

## 7. 测试策略(分层)

- **纯逻辑**(情绪衰减、记忆重排打分):直接单元测试,不连网。投入产出最高,优先写。
- **编排器**:注入 mock 子系统 + mock LLM,断言管线顺序、prompt 组装、`afterReply` 被触发。**不连数据库不调模型**就能测整条编排逻辑——这就是依赖注入留口子的回报。
- **子系统集成**:各自连真实 Supabase 测读写。
- **端到端**:跑一轮真实对话,人工看回复质量。

记忆/情绪这种"质量类"的东西没法纯断言,靠端到端人工观察 + 调参。逻辑类的用例则要尽量自动化兜底。

---

## 8. 风险与规避

| 风险 | 规避 |
|---|---|
| 后台任务随进程重启丢失 | M0~M4 可接受(丢一条提取无伤);M5 上队列持久化 |
| 记忆提取不准(记了垃圾/漏了重点) | 调 importance 门槛 + 人工抽查提取结果 + 攒几轮批量提取 |
| 情绪被一句话操纵到极端 | 阻尼 + 单轮上限 + clamp([情绪系统设计方案](emotion-design.md)第 10 节) |
| LLM 延迟拖慢回复 | 同步路径只留必要调用;独白可关;后台活全异步 |
| 成本失控 | 只有回复用好模型,其余便宜模型;记忆提取批量化 |
| 区域访问不稳 | 用 OpenRouter 做容灾,关键模型备一个 fallback |
| 自拍每次脸不一样 | 形象锚 + IP-Adapter 起步,认真做训角色 LoRA 锁脸 |
| 图像生成慢/贵 | 自拍走后台异步生成 + 图库复用(先查库再生成),不实时阻塞对话 |

---

## 9. 并行开发建议(配合你的多终端流)

接口契约冻结后,M2 起的子系统天然适合并行。一个可行的分工切法:

```
终端 A: StateLayer + emotion 维度(双层状态 + 演变 + toPrompt)  —— 照情绪文档写
终端 B: relationship 包                                —— 最简单, 可顺手
终端 C: 编排器接线(把 stateLayer 插进 reply/afterReply) —— 等 A 的门面壳子就能先写
终端 D: 测试(逻辑单测 + 编排器 mock 测)
```

因为大家只依赖**门面签名**(已冻结)、互不 import,合并冲突极小。编排器侧先用空壳门面把线接好,A/B 填完实现直接替换,不用等。

---

## 10. 下一步

最务实的起手式:**今天就把 M0 第 1~3 步搭起来**(工程骨架 + LLM 封装 + 人格),手动塞两条记忆,跑通那条 curl。主干立起来后,后面每个子系统都是往上插,节奏会很快。
