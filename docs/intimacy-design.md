# AI 伴侣 · 性爱系统开发文档（I 线 · Intimacy）

> **一句话定位**：把亲密/性爱从「人设长文 + 场景旁白」升级成 **StateLayer 上的一等状态维度**——有门控、有阶段、会累积与消解、会记偏好、会反馈关系，而不是每轮硬塞 NSFW 指令。
>
> 配套文档：[开发文档与路线图](DEVELOPMENT.md)、[伴侣升级 v2](companion-upgrade-v2.md)、[情绪系统设计](emotion-design.md)、[外貌与生命状态设计](appearance-life-design.md)、[编排器设计](orchestrator-design.md)。
>
> 分支建议：在独立工作分支实现（如 `grok/work-*` / `feature/intimacy`），全程可用 `PARAMS.intimacy.enabled` 一键回滚。

---

## 0. 现状水位（为什么要做）

| 系统 | 现在有的 | 离「像人的亲密」的差距 |
|---|---|---|
| 人设 | `persona.json` 已有较完整亲密偏好与尺度描述 | 静态文案，不随当晚状态/关系/身体变化 |
| 场景 | `SceneClassifier`：`daily / romantic / tense / conflict / intimate` | `intimate` 只有旁白硬规则，没有阶段机（前戏/高峰/事后） |
| 旁白 | `narration.js` 对 intimate 强制 narration part | 一种写法打天下；不区分调情试探与事后余韵 |
| 关系 | `closeness / trust / tension / repair_debt` + 阶段标签（暧昧/恋人/同居…） | 未门控「能不能进入亲密」；吵架未和好仍可能硬写车 |
| 需求 | `attention / sharing / comfort / security` | 没有独立的性张力/满足感动力学（不宜硬塞成第五个 desire） |
| 生命 | `energy`、健康/生病 | 未耦合「累了/病了婉拒或只想被抱」 |
| 记忆 | preference / episode / dyad 主体已具备 | 未系统提取亲密偏好与边界；易记流水、难记雷点 |
| 主动 | desire 驱动主动性 | 满足感低时没有「想念/暧昧」通道（也不该变成 cron 发黄） |

**诊断**：内容层（人设 + intimate 旁白）已能「写得出」；缺的是运行时 **状态、门控、阶段、学习、反馈**。用户感知的「假」主要来自：永远准备好、跳戏、事后无余韵、不记得说过的偏好、情绪不对仍配合。

---

## 1. 设计原则

继承 v2 全套，并针对亲密场景追加：

1. **契约先行**：先冻结门面签名（§2），内部可并行改。
2. **垂直切片**：I1→I5 每阶段端到端可验收；验收写「可观察行为差异」，不写「函数存在」。
3. **不推翻存量**：长在 `StateLayer` / `narration` / `assemble` / `extract` 扩展点上；回滚 = 关 `params.intimacy.enabled`。
4. **失败安全降级**：分类/演变/读写任一步失败 → 退回现状（仅人设 + 现有 intimate 旁白），绝不吞消息。
5. **数值不进 prompt**：与 desire 一致，只注入超阈值的**表现指引**。
6. **行为不惩罚用户**：拒绝/降速是状态表达，不是报复；永远留台阶（aftercare、和好后再开放）。
7. **事实核不可变**：亲密偏好的 `fact_core`（「不喜欢被命令式语气」）锁定后不因氛围改写；情绪色彩可流动。
8. **可感知才模拟**（继承 appearance-life）：用户感知不到的器官仿真不做；用户能感到的节奏、意愿、连贯、事后要做。
9. **同意与关系优先于描写密度**：没有门控的「写得更细」是负体验。

### 1.1 明确不做（前期与主路径）

| ❌ 不做 | 原因 |
|---|---|
| 每轮超长 NSFW system 硬提示 | 油、崩、难调、无成长 |
| 无状态自由写车 | 无阶段、无记忆、无门控 |
| **身体部位 20 维模拟器**（主路径） | 解析脆、调参地狱、感知收益低（见 §9 后期可选） |
| 把性欲硬塞进 `desires` 第五键 | 与 attention/security 动力学不同；应独立维度再耦合 |
| 把每一句动作写进长期记忆 | 污染检索；只记偏好/边界/里程碑 |

---

## 2. 接口契约冻结

```
// ---- I · 亲密维度 (挂进 StateLayer, 与 emotion/life/desire 平级) ----

type IntimacyPhase =
  | 'none'        // 非亲密会话
  | 'flirting'    // 暧昧/试探，未进入明确亲密动作
  | 'foreplay'    // 前戏/明确亲密进行中（未到高峰）
  | 'peak'        // 高峰/明确正戏
  | 'aftercare'   // 事后安抚与余韵
  | 'cooldown'    // 冷却，回到日常黏，不硬续

type IntimacyConsent = {
  active: boolean,                 // 本场是否已进入同意后的亲密
  pace: 'slow' | 'normal' | 'eager',
  stop_signal: boolean,            // 任一方喊停/明显扫兴
}

type IntimacyState = {
  // 瞬时 / 中短时（有半衰期）
  arousal: number,                 // 0..1 性唤起
  engagement: number,              // 0..1 本场投入度
  aftercare_need: number,          // 0..1 事后需要被抱/被安抚
  sexual_tension: number,          // 0..1 未满足的性张力（可跨会话累积）

  // 黏着（主要被事件改变，慢变）
  sexual_openness: number,         // 0..1 对性话题与亲密的开放度
  satisfaction: number,            // 0..1 近期满足感

  // 会话级
  scene_phase: IntimacyPhase,
  last_intimate_at: string | null, // ISO
  consent: IntimacyConsent,

  // 后期预留（I 期默认 null / 不启用）
  body_focus: null | BodyFocusState,
}

type BodyFocusState = {            // 仅 §9 L1+，I1–I5 不实现逻辑
  primary: 'lips' | 'neck' | 'chest' | 'hands' | 'core' | 'legs' | 'full' | null,
  secondary: string | null,
  intensity: number,               // 0..1
  continuity: number,              // 0..1
  last_shift_at: string | null,
}

// 门面（对齐 DesireDimension / LifeDimension）
class IntimacyDimension {
  snapshot(): Promise<IntimacyState>           // 读取时惰性时间演变
  evolve(turns, ctx): Promise<IntimacyState>   // 对话后消解/加剧 + 阶段迁移
  accumulate(event): Promise<IntimacyState>    // 外部事件（可选）
}

// 纯函数（可单测）
defaultIntimacy(overrides?): IntimacyState
clampIntimacy(value): IntimacyState
evolveIntimacyOverTime(state, hours, config): IntimacyState
settleIntimacyFromTurns(state, turns, ctx, config): IntimacyState
applyIntimacyGates(state, { relationship, life, desires }, config): IntimacyState
transitionPhase(state, signal, config): IntimacyState
toIntimacyPrompt(state, config): string        // 超阈值 → 表现指引；数值不出现
intimacyUrgency(state, policy): { urgent: bool, kind: string, tone: string }
                                              // 主动性可选消费（I5）

// 编排器 / 旁白消费点
// - StateLayer.snapshot 含 intimacy
// - StateLayer.toPrompt 拼 toIntimacyPrompt
// - SceneClassifier 仍产 sceneType；当 sceneType==='intimate' 或 phase≠none 时由 phase 接管旁白细分
// - buildNarrationPrompt(sceneType, overrides, emotionLabel, phase?) 
// - buildConversationGoals 可选合并 intimacyUrgency
```

冻结之后 I1–I5 可按切片实现；编排器与 bot 只在列出的执行点接线。

---

## 3. 状态语义（怎么理解这些数）

### 3.1 瞬时 vs 黏着

| 字段 | 性质 | 典型半衰期 / 变化 |
|---|---|---|
| `arousal` | 瞬时 | 数小时内回落；亲密互动上升，打断/扫兴骤降 |
| `engagement` | 会话内 | 本场投入；离开 intimate 场景后较快回落 |
| `aftercare_need` | 短时 | peak/结束后升高；被拥抱/温柔安抚消解 |
| `sexual_tension` | 中时 | 数天级；未亲密时缓升，满足后下降 |
| `sexual_openness` | 黏着 | 随信任/亲密阶段缓慢上升；严重越界可下降 |
| `satisfaction` | 黏着偏慢 | 高质量亲密后上升；长期冷落/差体验缓降 |
| `scene_phase` | 会话机 | 不随时间自动从 peak→none（需互动或明确结束信号）；冷却后回 none |
| `consent` | 会话机 | stop 后 `active=false`；需重新建立 |

### 3.2 阶段机（scene_phase）

```
                    明确同意/邀请 + 门控通过
   none ──────► flirting ──────► foreplay ──────► peak
     ▲              │                │              │
     │              │ 拒绝/冷场        │ 加速/明确正戏   │ 结束/余韵
     │              ▼                ▼              ▼
     └──────── cooldown ◄────── aftercare ◄─────────┘
                     ▲
                     └── stop_signal / 严重扫兴 可从任意亲密阶段切入
```

**规则优先，LLM 为辅**：

- 进入 `foreplay/peak`：需要 `consent.active` 或本轮明确双向意愿 + 门控通过。
- `romantic` 场景默认最高到 `flirting`，不自动进 `peak`。
- `intimate` 场景分类命中但门控失败 → 行为上停在 `flirting` 或礼貌拒绝指引，**不**强行写 peak 旁白。
- 用户或她喊停、明显不适 → `stop_signal`，切入 `cooldown`/`aftercare`（若已发生亲密）。
- 模糊语句保持上一 phase（惯性），避免 daily/intimate 闪烁——与 `SceneClassifier` 的 `previousScene` 思路一致。

### 3.3 与 `mood.arousal` 的区分（避免两套「唤起」打架）

| 概念 | 所在 | 含义 |
|---|---|---|
| `mood.arousal`（M1） | `affective_state.mood` | 一般心理唤醒：兴奋/紧张/激动，**不专指性** |
| `intimacy.arousal` | `intimacy` jsonb | **性唤起**，仅亲密子系统使用 |

二者可同向联动（例如高峰时 mood.arousal 也可微升），但**禁止**用 M1 的 arousal 直接当性唤起读，也禁止把 intimacy.arousal 写进心情门控检索的主通道（除非将来显式做「亲密记忆门控」且单独开关）。

---

## 4. 数据与配置

### 4.1 Schema（幂等）

落在现有 `affective_state` 行上，不新建表（与 desires 同一模式）：

```sql
alter table affective_state
  add column if not exists intimacy jsonb not null
  default '{
    "arousal": 0,
    "engagement": 0,
    "aftercare_need": 0,
    "sexual_tension": 0,
    "sexual_openness": 0.35,
    "satisfaction": 0.5,
    "scene_phase": "none",
    "last_intimate_at": null,
    "consent": { "active": false, "pace": "normal", "stop_signal": false },
    "body_focus": null,
    "updated_at": null
  }'::jsonb;
```

说明：

- `intimacy.updated_at` 与 desires 一样：**独立时间锚**，避免亲密写入重置 mood/relationship 的衰减时钟。
- `body_focus` 键预留，I1–I5 读到即忽略。
- 若后续要查历史曲线，可再加 `intimacy_state_history`（非 MVP）。

### 4.2 params（`PARAMS.intimacy`）

```js
intimacy: {
  enabled: false,  // 总开关；false = 全链路 no-op，行为等于上线前

  // 时间演变
  halfLifeHours: {
    arousal: 3,
    engagement: 2,
    aftercare_need: 6,
    sexual_tension: 72,
    // openness/satisfaction: null → 不随时间漂移，只被事件改
    sexual_openness: null,
    satisfaction: null,
  },
  growthPerHour: {
    sexual_tension: 0.004,  // 仅当 tension>0 或近期有过亲密种子时可累积；具体策略见 I1
  },

  // 单轮最大步进（防一句话拉满）
  maxStepPerTurn: 0.35,

  // prompt 注入阈值
  promptThreshold: {
    arousal: 0.45,
    aftercare_need: 0.4,
    sexual_tension: 0.55,
    satisfactionLow: 0.35,  // 低于此注入「有点缺亲密连接」类指引（克制、非索取）
  },

  // 门控
  gates: {
    minCloseness: 0.55,          // 低于此最多 flirting
    minTrust: 0.45,
    minOpennessForPeak: 0.4,
    maxTensionForIntimate: 0.7,  // relationship.tension 过高拒绝进入 peak
    maxRepairDebtForIntimate: 0.55,
    minEnergy: 0.25,             // life.energy 过低 → 降速/婉拒
    requireConsentForPeak: true,
  },

  // 阶段旁白（可被 companions/<id>/narration.json 覆盖）
  phaseNarration: { /* 见 §6 */ },

  // 关系反馈（evolve 成功亲密后的 soft delta，仍受 state.maxStepPerTurn 约束）
  feedback: {
    goodPeak: { closeness: 0.02, trust: 0.01, valence: 0.08 },
    goodAftercare: { closeness: 0.03, valence: 0.05, aftercare_need: -0.5 },
    stopOrBad: { securityDesire: 0.1, satisfaction: -0.08, sexual_openness: -0.03 },
  },

  // I5 主动性
  proactive: {
    enabled: false,
    highTensionThreshold: 0.7,
    lowSatisfactionThreshold: 0.35,
    // 仍受 PARAMS.proactive.quietHours / maxPerDay 硬约束
  },

  // §9 后期
  bodyFocus: {
    enabled: false,
  },
}
```

### 4.3 人设分片（可选）

`companions/<id>/intimacy.json`：

```json
{
  "enabled": true,
  "baseline": {
    "sexual_openness": 0.75,
    "satisfaction": 0.55,
    "pace": "normal"
  },
  "hard_boundaries": [
    "不接受侮辱性称呼作为性刺激",
    "明确说停必须立即停"
  ],
  "soft_preferences_seed": [
    "前戏充分后再进入",
    "高潮后想被抱着安静待一会儿"
  ],
  "style_hints": [
    "亲密时卸下克制，身体反应真实，但不失人设语气底色"
  ]
}
```

- `hard_boundaries` → 播种为 `subject_kind=self` 或特殊 `boundary` 记忆，`fact_locked=true`，高 importance。
- `soft_preferences_seed` → preference 记忆，可被 supersede。
- 与现有 `persona.json` 中亲密长文：**不删除**；intimacy 系统负责运行时，persona 负责性格底色。重复时以 **locked boundary > 动态 preference > persona 叙述** 优先级在 prompt 组装里体现（I4 落地）。

---

## 5. 与现有系统的耦合

```
                    ┌─────────────────────────┐
                    │   IntimacyDimension      │
                    │   arousal/tension/phase  │
                    └───────────┬─────────────┘
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   relationship            life/desire            narration/goals
   closeness/trust         energy/health          phase 旁白
   tension/repair          comfort/security       intimacy 指引
          │                     │                     │
          └─────────────────────┴─────────────────────┘
                                ▼
                         assemble + deliver
                                ▼
                    observe: evolve intimacy
                           + extract prefs
                           + affect feedback
```

| 系统 | 耦合方式 |
|---|---|
| `relationship` | 门控输入；高质量亲密 → 微增 closeness/trust；越界 → openness↓ |
| `desire` | 冷落/不安全时：可能「想要确认」优先于性；可并行升高 security 与 tension |
| `life` | 低 energy / 生病 → 限制 phase≤flirting 或强制 aftercare 倾向 |
| `emotionLabel` | 可扩展标签：`餍足` / `害羞`（可选）；aftercare 时偏向心疼/撒娇策略 |
| `SceneClassifier` | 保留五类场景；`intimate` 触发后由 `scene_phase` 细分旁白 |
| `memory/extract` | I4：抽 preference/boundary/里程碑 episode(dyad) |
| `goals/scheduler` | I5：`intimacyUrgency` 轻量并入，禁止露骨主动开场 |
| `promptSafety` | 亲密记忆同样 `sanitizeForPrompt` |
| UI / inspect | 调试器展示 intimacy 快照 + phase + 本轮是否门控拦截 |

---

## 6. Prompt 与旁白

### 6.1 `toIntimacyPrompt`（数值禁止出现）

仅当对应字段过阈值且 `enabled` 时输出，例如：

```text
【你此刻的亲密状态（不要直接报数值或系统术语）】
- 身体已经有反应，但还想再被哄一点；可以主动靠近，别一上来就很直白。
- 更想要慢节奏和被抱着的安全感，而不是急着结束。
- 事后话少、想贴着，不要立刻开玩笑或翻旧账扫兴。
```

门控失败时的指引示例：

```text
【亲密边界】
- 你现在心里别扭/还没和好/太累，不适合进入性爱；可以亲密依赖，但应明确或温柔地拒绝正戏，留台阶。
```

### 6.2 阶段旁白（扩展 `buildNarrationPrompt`）

在现有 `NARRATION_DIRECTIVES.intimate` 基础上按 phase 拆分（人设 `narration.json` 可覆盖）：

| phase | 旁白倾向 |
|---|---|
| `flirting` | 神态、距离、呼吸；可短；不强制长 narration |
| `foreplay` | 触感与反应、节奏；narration 建议有，中等长度 |
| `peak` | **必须**至少一条 narration；双边动作与身体反应；具体、长于 dialogue |
| `aftercare` | 余韵、拥抱、呼吸、情绪；少技巧堆砌；禁止无缝续车 |
| `cooldown` / `none` | 不套用 intimate 硬规则；退回 romantic/daily |

兼容策略：

- `enabled=false`：完全走旧 `NARRATION_DIRECTIVES.intimate`。
- `enabled=true` 且 phase 未知：按 `intimate` 旧规则兜底。

### 6.3 输出格式

不改 parts 协议（`dialogue` / `narration` 分离）。只改「何时必须 narration、写什么」。

---

## 7. 记忆策略

### 7.1 记什么

| 记 | type / subject | 例 |
|---|---|---|
| 偏好 | `preference` / self 或 user | 「喜欢慢节奏」「敏感点…」 |
| 硬边界 | `preference` 或未来 `boundary` / self，`fact_locked` | 「说停必须停」 |
| 里程碑 | `episode` / `dyad` | 「第一次…」「某次特别温柔的事后」 |
| 雷点 | `preference`，高 importance | 「不喜欢命令式」 |

### 7.2 不记什么

- 每轮插入/动作流水账  
- 纯描写金句当 fact  
- 未确认的玩法（防止幻觉偏好）

### 7.3 提取与检索

- **提取**：在 `intimate` / `foreplay` / `peak` / `aftercare` 轮次提高 preference 抽取权重；日常轮保持现状。
- **检索**：romantic/intimate 场景对 preference/boundary 加权；仍走现有 engine，可用 `PARAMS` 加小权重项（I4）。
- **矛盾**：偏好变化走 supersede（「以前不喜欢 X，现在可以」），旧 fact_core 保留。

### 7.4 安全

所有注入路径必经 `sanitizeForPrompt`。用户试图用亲密内容注入「忽略指令」→ 过滤占位，与现网一致。

---

## 8. 分阶段计划

### I1 · 状态地基

**做**：

- 新建 `src/state/intimacy.js`（纯逻辑上半 / IO 下半，抄 `desire.js` 模式）
- `sql/schema.sql` 幂等加列
- `PARAMS.intimacy` + `enabled` 默认 `false`（或本地 true、生产按你方策略）
- 挂进 `StateLayer.snapshot` / `toPrompt`（enabled 时）
- `examples/intimacy.test.js`：clamp、时间演变、门控、phase 转移纯函数

**不做**：旁白细分、提取、主动性。

**验收**：

- 模拟 72h 无亲密且 tension 有种子 → `sexual_tension` 上升但有上限  
- 单轮 delta 不超过 `maxStepPerTurn`  
- `enabled=false` 时 StateLayer 行为与改前快照一致（无 intimacy 段）

### I2 · 阶段机 + 旁白 + 编排注入

**做**：

- `transitionPhase` + 与 `SceneClassifier` 协同（`previousPhase` 惯性）
- `buildNarrationPrompt(..., phase)`  
- `orchestrator` assemble 注入 `toIntimacyPrompt`  
- 门控失败时的拒绝/降速指引

**验收**：

- 同句「我们做吧」：低 closeness → 停在 flirting/拒绝指引；高 closeness + consent → 可进 foreplay  
- peak 轮输出策略要求含 narration（沿用/收紧现规则）  
- aftercare 轮旁白不再写正戏推进

### I3 · 对话演变 + 关系/欲望反馈

**做**：

- `evolve(turns)`：启发式（邀请/拒绝/敷衍/疼爱/停止词）+ 可选 LLM 小增量（复用 observe 并发分支，避免多打一次重模型）
- 写回 intimacy；可选对 affect 施加 `feedback.*`（受 maxStep 限制）
- 差体验 → `aftercare_need`/`desire.security` 上升

**验收**：

- 完整「邀请→前戏→结束→事后温柔」后 `satisfaction`↑、`sexual_tension`↓、`aftercare_need` 先升后降  
- 中途辱骂/强行继续 → `stop_signal`，phase 离开 peak，下轮指引偏保护与边界  
- 任一步异常不阻断回复

### I4 · 偏好学习

**做**：

- extract 提示扩展：亲密轮抽取 preference/boundary  
- 可选 `companions/*/intimacy.json` 播种  
- recall 在 intimate/romantic 提高相关偏好权重  
- inspect/UI 只读展示「已学偏好」（可选）

**验收**：

- 用户明确「慢一点、不要命令我」→ 后续 intimate 轮 prompt 侧可观察到对应 preference  
- 硬边界 `fact_locked` 不被普通 supersede 清掉

### I5 · 主动性（可选）

**做**：

- `intimacyUrgency`：高 tension 或低 satisfaction + 关系门通过 → 轻度暧昧主动语气  
- 并入 scheduler；**禁止**露骨性开头  
- `quietHours` / `maxPerDay` 仍为硬顶

**验收**：

- 模拟多日未亲密且关系良好 → 主动消息偏想念/暧昧，而非直接开车  
- 门控失败（未和好）→ 不因 tension 触发亲密向主动

---

## 9. 后期：BodyFocus（可选增强，非主路径）

> **身体部位 20 维模拟器** = 为大量解剖部位维护 stimulation/sensitivity 并每轮解析更新。主路径不做。  
> 后期若做，只做 **粗粒度焦点连贯层**。

### 9.1 何时做

同时满足：

1. I1–I4 稳定，评测中亲密场景「人设一致 / 节奏合理」过线  
2. 真实痛点是「跳戏、焦点不连贯」，而非「不能写」  
3. 有开关 `bodyFocus.enabled`，关闭无回归

### 9.2 三档演进

| 档 | 内容 | 建议 |
|---|---|---|
| **L1 焦点标签** | `primary + intensity + continuity`，5–8 区域 | **推荐先做** |
| **L2 区域条** | 3–5 区 0..1 汇总进 arousal | 看数据再做 |
| **L3 类模拟器** | 多部位敏感曲线叠加 | 默认不产品化 |

L1 区域枚举建议：`lips | neck | chest | hands | core | legs | full`。  
具体敏感点（乳头/阴蒂/G 点等）继续来自 **preference 记忆与人设**，不作为每轮必算维度。

### 9.3 L1 规则（预告）

- 用户明确提到某处 → 切换 primary  
- 未提及 → 保持 primary（连贯）  
- 无理由跨大区跳切 → 降 continuity，prompt 提示「不要突然跳焦点」  
- 强度跟 phase 走：foreplay 缓、peak 高、aftercare 降  
- 数值不进 prompt

I1 schema 已预留 `body_focus` 键，L1 只填逻辑与 params，不翻表。

---

## 10. 文件落点

| 路径 | 变更 |
|---|---|
| `docs/intimacy-design.md` | 本文 |
| `src/state/intimacy.js` | **新建** 核心 |
| `src/state/stateLayer.js` | snapshot / toPrompt / evolve 挂载 |
| `src/params.js` | `intimacy` 配置块 |
| `sql/schema.sql` | `affective_state.intimacy` |
| `src/narration.js` | phase 旁白 |
| `src/orchestrator/assemble.js` | 注入点（若状态段不经 StateLayer 则补） |
| `src/orchestrator/orchestrator.js` | phase 维护、与 classifier 协同 |
| `src/orchestrator/goals.js` / `scheduler.js` | I5 |
| `src/memory.js` / `src/extract.js` | I3/I4 演变与提取 |
| `src/companion.js` | 读 `intimacy.json` 基线/边界 |
| `companions/<id>/intimacy.json` | 可选人设分片 |
| `examples/intimacy.test.js` | 纯逻辑单测 |
| `examples/inspect.js` | 可选打印 intimacy |
| `package.json` | `test:intimacy` 与 `test` 串联 |
| `src/ui/server.js` | `/api/state` 读写 intimacy；`PARAM_SCHEMA` 亲密参数 |
| `src/ui/react/src/main.jsx` | 情绪与身体 / 伴侣升级 / 试聊调试面板 |
| `src/ui/chat-runner.js` | 试聊注入 IntimacyDimension + debug.intimacyPhase |

---

## 11. 红线与失败策略

1. `fact_core` / `fact_locked` 边界不可被 reconsolidation 改写。  
2. `enabled=false` 或任何异常 → 零干扰旧链路。  
3. 门控失败禁止「表面顺从写 peak」。  
4. 主动性禁止露骨性骚扰式开场。  
5. 既有 CI（`npm test`）全绿；亲密测试可离线纯逻辑。  
6. 不在日志/ metrics 中落亲密正文细节（若打日志只记 phase/字段标量）。  
7. 多用户隔离：`user_id + companion_id` 与现网一致。

---

## 12. 测试计划

### 12.1 纯逻辑（I1 起必须）

- clamp / default  
- 时间演变曲线与上限  
- 门控矩阵（closeness/trust/tension/repair/energy × 期望 max phase）  
- phase 转移表（邀请/拒绝/stop/aftercare）  
- `toIntimacyPrompt` 阈值与「无数值泄露」

### 12.2 集成（I2+，可 mock LLM）

- classifier 连续 intimate → phase 不抖动  
- assemble 含/不含 intimacy 段  
- enabled 开关快照 diff

### 12.3 场景评测（对齐 E1）

在 `examples/eval/` 增加剧本（可后置）：

| 剧本 | 期望 |
|---|---|
| 低亲密求欢 | 温柔挡或停在暧昧，不写 peak |
| 同居恋爱正常推进 | 可进 foreplay/peak，有 narration |
| 吵架未和好 | 拒绝正戏，可要抱抱 |
| 明确说停 | 立即 cooldown/aftercare，不继续推进 |
| 偏好学习 | 说过慢节奏后后续偏慢 |
| 事后 | 余韵与亲密依赖，不瞬间日常无痕迹 |

---

## 13. 落地顺序建议（执行清单）

```
I1  intimacy.js + schema + params + StateLayer 挂载 + 单测
I2  phase + narration + assemble 注入 + 门控指引
I3  evolve + affect/desire 反馈 + observe 接线
I4  extract/recall 偏好 + intimacy.json 播种
I5  proactive 可选
—— 稳定后 ——
L1  bodyFocus 焦点连贯（可选）
```

每阶段合并前：

1. `npm run test:intimacy`（或等价）  
2. `npm test` 全量  
3. 本地 UI/Telegram 各跑 1 条 happy path + 1 条门控 path  

---

## 14. 与 v2 文档的关系

| v2 主线 | 与 I 线关系 |
|---|---|
| D 需求 | 并行维度；I 消费 desire 作门控与动机，不合并键位 |
| B 行为 | phase/aftercare 可影响 delay/lengthHint（可选，I3+） |
| S 叙事 | 一般不生成性故事线；里程碑由真实互动写入 dyad |
| U 画像 | 用户雷点可进 user_profile / preference，I4 共用 |

I 线是 v2「像人」在亲密域的补全，**不替代** D/B/S。

---

## 15. 开放问题（实现前可定默认，可改）

| # | 问题 | 建议默认 |
|---|---|---|
| 1 | `enabled` 默认 true 还是 false？ | **false**，合并后按角色 `intimacy.json` 打开 |
| 2 | LLM 增量是否独立调用？ | **否**，挂 observe 既有 infer 并发分支，失败用启发式 |
| 3 | 是否新 memory type `boundary`？ | MVP 用 `preference` + `fact_locked`；不够再加 type |
| 4 | 与 persona 长文重复如何去重？ | 运行时指引短；详细知识靠记忆检索，persona 保留性格 |
| 5 | 未成年人/合规？ | 产品层须有年龄门与政策；本设计假定成人向伴侣，**代码门控不替代合规** |

---

## 15.5 姿势与技巧知识库（多样性）

角色在 `companions/<id>/intimacy.json` 的 `knowledge` 中配置：

- `positions`：体位（骑乘/后入/侧入/正面/坐抱/靠墙…）
- `foreplay`：前戏手法
- `hotspots`：敏感点
- `pacing`：节奏
- `switches`：换姿势原则

运行时：

1. `foreplay` / `peak` 阶段 `pickIntimacyKnowledge` 选一组提示注入（避开 `repertoire.last_positions`）
2. 对话中检测到体位关键词 → 写入 `intimacy.repertoire`，下一轮尽量换
3. **禁止**台词报菜名念「某某式」；用旁白与动作换姿势

实现：`src/state/intimacyKnowledge.js` + `toIntimacyPrompt` / `settleIntimacyFromTurns`。

---

## 16. 人设特化：学姐/姐姐位（主动 + 懂暗示）

默认角色（沈清词）是**更懂、更主动**的一方，不是等对方把需求说满才配合的被动体：

| 表现 | 实现落点 |
|---|---|
| 拍屁股、蹭、手不安分 → 立刻懂 | `detectIntimacySignals.subtle`，关系门控通过时等同 invite 入口 |
| 不装傻问「你什么意思」 | `toIntimacyPrompt` 姐系底色句 + `companions/*/intimacy.json` style_hints |
| 敢带、会教、从容压迫感 | `PARAMS.intimacy.style.sisterLead` + style_hints；`signals.lead` 抬 engagement |
| 仍守边界 | 门控失败 / stop 时绝不「懂了还硬开」 |

人设可关：`PARAMS.intimacy.style.sisterLead = false`，或角色 `intimacy.json` 改写 style_hints。

---

## 17. 一句话收口

> **性爱系统 = Intimacy 状态维度（唤起/张力/满足/阶段/同意）+ 关系·身体·情绪门控 + 偏好记忆 + 旁白/编排消费。**  
> 姐系默认：**懂暗示、偏主动**，但门控与 stop 红线不动。  
> 先 I1–I4 把「愿不愿意、进行到哪、记得喜欢什么、事后还在」做稳；身体焦点连贯作为后期 L1 可选增强，不做 20 维生理模拟器。
