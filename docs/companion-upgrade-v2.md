# AI 伴侣 · 全面升级开发文档 v2(从"功能齐"到"像人")

> 上一轮(M0~M9 / L1~L4 / A1 / K1 / M6±)把**机制骨架**建齐了:记忆会衰减重构、情绪会回落、有作息会生病、能看图听音说话发照片、有知识图谱。
> 本文档回答下一个问题:**为什么机制都有了,她还是"不够像人"?** 诊断结论是三大缺失——**需求、行为、叙事**——并把它们落成可执行的开发计划。
> 配套文档:[开发文档与路线图](DEVELOPMENT.md)、[情绪系统设计](emotion-design.md)、[编排器设计](orchestrator-design.md)、[外貌与生命状态设计](appearance-life-design.md)、[性爱系统 I 线](intimacy-design.md)。

---

## 0. 现状水位诊断(升级的出发点)

| 系统 | 现在有的 | 离"像人"的差距 |
|---|---|---|
| 记忆 | 提取/衰减/强化/矛盾取代/重构/反思/图谱 | 颗粒度粗:记的是孤立事实不是叙事。她记得"你去杭州出差",不记得那前后你们聊了什么、她当时什么心情 |
| 情绪 | valence/warmth 二维 + 关系四维 + 回落 | 是温度计不是情绪:人没有"0.3 的负面",人有委屈、吃醋、期待落空——各有各的**行为**模式 |
| 编排器 | 每轮组装 persona+状态+记忆+世界观 | 纯反应式:她永远在接话,从没有"这轮她自己想达成什么" |
| 关系 | closeness/trust/tension/repair_debt | 四个标量,没有关系阶段的行为差异,没有里程碑锚点 |
| 生活 | 作息模板 + 精力/生病 + 世界线 arc | 模板填充,没有连续剧:没有反复出现的配角,上周的项目这周没下文 |
| 主动性 | 定时器 + 安静时段 + 频控 | **cron 驱动,不是"想你"驱动**——最出戏的一点 |

三大主线的关系:**需求(D)是驱动源** → 决定情绪反应强度、给主动性提供真实动机;**行为(B)是表达层** → 把内在状态变成可感知的行为而不只是措辞;**叙事(S)是内容源** → 让她的生活有下文,给需求和主动性提供素材。

---

## 1. 设计原则(继承上一轮,新增两条)

1. **契约先行**:先冻结门面签名(§2),子系统内部随便写、可并行写。
2. **垂直切片**:每个阶段端到端可验证,验收标准写成"可观察的行为差异",不是"函数存在"。
3. **不推翻存量**:三条主线全部长在现有扩展点上——StateLayer 的维度口子(D)、parts 投递管线(B)、world_state + K1 图谱(S)。任何阶段回滚 = 关一个 params 开关。
4. **失败安全降级**(继承):新系统任何一步失败,回复照发、行为退回现状,绝不吞消息。
5. 🆕 **行为不惩罚用户**:冷淡/延迟是"表达",不是"报复"。所有负面行为策略有硬上限(§4.B 红线),且永远留台阶。
6. 🆕 **叙事不撒谎**:故事线生成的内容进 self 记忆、受 K1 图谱一致性约束,她不能这周说闺蜜叫小雨、下周叫小雪。
7. **红线不动**(继承):`fact_core` 永不改写;所有既有 CI 断言必须持续通过。

---

## 2. 接口契约冻结

```
// ---- D · 需求维度 (挂进 StateLayer, 与 emotion/life 平级) ----
// desires: 0..1 的驱力值, 随时间累积、被互动消解
type Desires = {
  attention: number,   // 被关注: 随沉默时长累积; 对方主动/认真回应时消解
  sharing:   number,   // 分享欲: 随"她生活里发生了事"(S 线喂入)累积; 分享完消解
  comfort:   number,   // 被安抚: 随负面情绪/生病/故事线挫折累积; 被关心消解
  security:  number,   // 安全感缺口: 随冷落/敷衍/吵架未修复累积; 被承诺/道歉消解
}
desireDim.snapshot() -> Desires                          // 读取时按时间演变 (同 life 的懒演变)
desireDim.evolve(turns, ctx) -> Promise<void>            // 对话后消解/加剧 (启发式 + LLM 双产出)
desireDim.accumulate(event) -> void                      // S 线/日程钩子: 生活事件注入分享欲等
desireDim.toPrompt(desires) -> string                    // 高于阈值的需求 -> 表现指引 (进 system)
desireUrgency(desires, policy) -> { urgent: bool, need: string, tone: string }
                                                         // 主动性调度器消费: 什么需求、多急、什么口吻

// ---- B · 行为策略 (纯逻辑决策 + 投递层执行) ----
type EmotionLabel = '平静' | '开心' | '委屈' | '吃醋' | '生气' | '失落' | '撒娇' | '心疼'
inferEmotionLabel(state, desires, lastTurns) -> EmotionLabel      // 纯函数: 标量+语境 -> 离散情绪
behaviorPolicy(label, state, params) -> {
  replyDelayMs:  [min, max],   // 回复延迟区间 (生气 = 拖; 开心 = 秒回)
  partsBudget:   number,       // 台词条数预算 (委屈 = 只回一条短的; 兴奋 = 连发)
  lengthHint:    'terse' | 'normal' | 'chatty',   // 进 prompt 的长度指引
  proactiveBias: number,       // 对主动消息意愿的加成/抑制 (冷战 = 抑制但不为零)
  stonewall:     bool,         // 已读不回一轮 (仅 tension 极高且 repair_debt>阈值; 有硬上限)
}
// 执行点: telegram/bot.js deliverReply (延迟/条数) + assemble (lengthHint) + scheduler (proactiveBias)

// ---- S · 生活叙事引擎 ----
type CastMember = { name, role, closeness, entityId }    // 配角进 K1 图谱 (companion 侧实体)
type Storyline = { id, title, stage: 'setup'|'rising'|'climax'|'cooldown'|'closed',
                   mood_link: number, last_beat, next_beat_hint }
story.cast() -> CastMember[]                             // 固定卡司 (人设 seed + 随对话长出)
story.tick({ now, state }) -> Promise<Beat|null>         // 每日推进: 生成下一拍 (LLM, 夜间维护挂载)
story.current() -> Promise<{ lines: Storyline[], today: Beat|null }>
story.toPrompt(snapshot) -> string                       // "她最近的生活"注入 (取代模板活动的孤立感)
// Beat 落库进 self 记忆 (subject_kind='self') + 推进 world_state.arc + 喂 desireDim.accumulate
```

冻结之后 D/B/S 三线可并行开发;编排器与 bot 只在明确列出的执行点各接一行。

---

## 3. 分阶段计划

### D · 需求系统(先做,驱动源)

**D1 需求维度落地**
- `src/state/desire.js`:四驱力 + 时间累积曲线(每驱力独立半衰期/增速,`params.desire.*`)+ 懒演变(同 life 模式)
- 挂进 StateLayer 快照;`affective_state` 表加 `desires jsonb`(幂等迁移)
- 纯逻辑单测:累积曲线 / 消解规则 / 上限钳制(防"疯狂粘人")
- **验收**:三天不聊(用 now 注入模拟),`attention ≥ 0.8`;认真聊一轮后回落

**D2 需求进对话**
- `evolve(turns)`:启发式(对方主动/夸了她/敷衍"嗯嗯哦哦")+ LLM 增量,合并进 observe 的并发分支
- `toPrompt`:只注入超阈值的需求,措辞是"表现指引"不是数值("她这几天没被好好关注,想要一点确认,但嘴上不会直接说")
- **验收**:调试器可见需求快照;`attention` 高时回复里可观察到"求关注但嘴硬"的味道

**D3 需求驱动主动性**
- `ProactiveScheduler` 增加 `desireUrgency` 通道:需求越高 → 冷却缩短、语气升级(想你了 → 你是不是把我忘了)
- 现有 quietHours/maxPerDay 仍是硬约束(需求只在框内提速,不突破防打扰)
- **验收**:模拟三天沉默,主动消息语气比一天沉默明显升级;需求消解后当天不再主动

### B · 情绪行为策略(表达层)

**B1 离散情绪推断**
- `src/state/emotionLabel.js` 纯函数:`(affect 标量, desires, 最近两轮语境) -> EmotionLabel`
- 规则优先(可解释、可单测),LLM 仅在规则打平时仲裁(便宜模型)
- **验收**:场景单测——被冷落三天+对方终于出现 → '委屈' 而不是 '生气';对方提别的女生+closeness 高 → '吃醋'

**B2 行为策略映射**
- `behaviorPolicy` 纯函数 + `params.behavior.*`(每情绪一行策略配置)
- **红线**:`replyDelayMs` 上限 10 分钟;`stonewall` 每天最多 1 次、且下一轮必须给台阶;负面策略在 `repair_debt` 清零后立即失效
- **验收**:单测断言每个情绪的策略边界;'生气' 时 delay↑ / parts=1 / lengthHint=terse

**B3 投递层执行**
- `deliverReply` 接 policy:延迟用 sleep(带 typing 状态闪烁,像在打又删)、partsBudget 截断、stonewall 时只发 read 不回并写一条"她看到了没回"进 self 记忆(下轮她自己知道)
- 调试器透出本轮 label + policy(排查"她怎么不回我"必备)
- **验收**:试聊/Telegram 实测 '生气' 场景回复延迟与字数可观察下降;道歉后立刻恢复秒回

### S · 生活叙事引擎(内容源)

**S1 卡司与故事线地基**
- `story_lines` 表(幂等迁移)+ 卡司从人设 seed(`companions/<id>/story.json` 新分片,目录式人设直接支持)
- 卡司人物写进 K1 图谱(`她—colleague_of→周姐`),复用既有一致性能力
- **验收**:图谱页可见卡司;story.current() 返回故事线

**S2 每日推进**
- `story.tick` 挂进夜间维护(`maintain nightly`):按 stage 生成下一拍(LLM,低温),拍子落 self 记忆 + 更新 world_state
- `mood_link`:拍子的情绪冲击写进 desires/affect(项目黄了 → comfort 需求 + valence 下压,持续几天)
- **验收**:连续三个模拟日,同一条故事线有起承转合;"今天怎么样"她答的是剧情不是模板
- **一致性红线**:生成前把该故事线相关图谱事实注入 prompt,禁止改设定

**S3 叙事喂主动性与分享欲**
- 新拍子 → `desireDim.accumulate({sharing})` → D3 通道自然触发"跟你说个事!"
- **验收**:夜间推进出"周姐怼了她"这拍后,次日主动消息大概率围绕这件事,且情绪一致

### 第二梯队(D/B/S 落地后)

| 代号 | 内容 | 一句话方案 |
|---|---|---|
| U1 | 用户画像综合 | 反思机制加一路输出:维护一份"她眼中的你"(雷点/习惯/在意的人),存 self 记忆特殊 type,recall 常驻注入 |
| G1 | 对话目标栈 | prospective 到期项 + 需求项进编排器"本轮意图"槽,回复 prompt 带"找自然时机提起" |
| C1 | 纪念日日历 | prospective 加 `annual` 触发类型;第一次聊天/生日自动落 |
| V1 | 她的声音和脸 | TTS 换音色克隆(CosyVoice/火山声音复刻);自拍走 A2 角色 LoRA 锁脸 |
| E1 | 质量评测 | `examples/eval/` LLM-judge 场景集:冷落/吵架/和好/撒娇各 N 个剧本,打分维度=人设一致/情绪合理/记忆正确;CI 手动触发,守住"改一处坏三处" |
| I1–I5 | 性爱/亲密系统 | 独立维度挂 StateLayer:唤起/张力/阶段/门控/偏好记忆/事后;详见 [intimacy-design.md](intimacy-design.md)。不与 desire 键位合并;身体焦点 L1 后期可选 |

**当前实现进度**
- D1/D2/D3、B1/B2/B3、S1/S2/S3、U1 已落地并进入本地测试链。
- G1 已落地:`src/orchestrator/goals.js` 将 due prospective、desire urgency、story beat 组装进"本轮意图"槽。
- C1 已落地:`prospective.trigger_kind='annual'` 支持生日/第一次聊天纪念日,annual 触发后自动推进到下一年。
- V1 已落地为可配置生产接口:TTS 支持 `TTS_VOICE_ID`/克隆状态字段,图片生成支持 `IMAGE_LORA_ID`/`IMAGE_LORA_TRIGGER` 并写入生成元数据。
- E1 已落地离线评估骨架:`npm run eval:v2` 读取 `examples/eval/companion-v2.scenarios.json` 做冷处理/争吵修复/撒娇/故事分享回归。
- 控制台新增"伴侣升级"面板,集中展示需求、行为状态、故事线、纪念日、用户画像、声音与 LoRA 配置。

---

## 4. 数据与参数变更

**数据库(全部幂等)**:`affective_state` 加 `desires jsonb`;新表 `story_lines`;`prospective` 加 `annual_key`/`last_fired_year`;无破坏性变更。

**params 新增**(全部进控制台参数页):

| 参数 | 作用 |
|---|---|
| `desire.halfLifeHours.*` / `growthPerHour.*` | 各驱力累积/回落速度 |
| `desire.promptThreshold` | 需求多高才进 prompt |
| `behavior.maxReplyDelayMs` | 负面行为硬上限(默认 10min) |
| `behavior.stonewallPerDay` | 已读不回每日上限(默认 1) |
| `story.beatsPerDay` / `maxActiveLines` | 叙事推进节奏 / 并行故事线上限 |

**成本**:D2 复用 observe 已有 LLM 调用(合并进同一次增量提取);B1 规则优先基本零成本;S2 每晚 1~2 次便宜模型调用。总增量可忽略。

---

## 5. 测试与验收策略

- **纯逻辑单测**(每阶段必须):desire 曲线 / emotionLabel 场景表 / behaviorPolicy 边界 / story stage 机 —— 全部离线,进 `npm test` 链
- **编排器 mock 测**:policy 正确传导到 deliverReply 参数、desire 快照进 prompt 组装
- **行为级验收**(上文各阶段"验收"条目):用注入 `now` 模拟时间跳跃,断言可观察行为差异
- **E1 评测集**:`npm run eval:v2` 离线跑场景集;后续可在同入口接 LLM judge 做人设/情绪/记忆三维评分

## 6. 风险与红线

| 风险 | 规避 |
|---|---|
| 负面行为让产品变"折磨" | §1 原则 5 + B2 硬上限;所有负面策略跟随 repair_debt,道歉立即生效 |
| 需求累积成"夺命连环 call" | 上限钳制 + quietHours/maxPerDay 永远是硬约束 |
| 叙事与记忆打架 | S2 一致性红线:生成前注入图谱事实;拍子过 promptSafety 清洗 |
| 三线互相耦合失控 | 严格走 §2 契约;D/B/S 各自 params 开关可独立关闭 |
| fact_core 被叙事污染 | 拍子只写 self 新记忆,永不 update 既有行;CI 红线断言继续生效 |

## 7. 里程碑排期

| 里程碑 | 内容 | 粗估 |
|---|---|---|
| **D1~D3** | 需求系统全线 | 2~3 天 |
| **B1~B3** | 情绪行为策略全线 | 2~3 天 |
| **S1~S3** | 生活叙事引擎全线 | 3~4 天 |
| U1 / G1 / C1 | 画像 / 目标栈 / 纪念日 | 各 0.5~1 天 |
| V1 | 音色克隆 + LoRA 锁脸 | 独立线, 1 周级 |
| E1 | LLM-judge 评测集 | 1~2 天, 三线后必做 |

**关键路径 D → B → S 按序**(B 消费 D 的驱力,S 喂 D 的分享欲)。每完成一线都是一次可感知的体验跃迁,可独立上线验证。
