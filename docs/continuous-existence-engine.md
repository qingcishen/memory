# Continuous Existence Engine · 持续存在引擎

**版本**: v1.0  
**状态**: 设计稿  
**目标**: 让 AI 伴侣从「消息响应系统」升级为「持续存在的主体」

---

## 一、设计哲学

### 当前系统的本质问题

```
现在：  消息到达 → 系统唤醒 → 生成回复 → 系统休眠
         ↑
         这不是伴侣，这是客服
```

用户感知到的所有「怪」——开车几秒到家、定时找人感觉假、人设前后不一——根源只有一个：

**AI 不存在于时间里，只存在于消息里。**

### 突破方向

```
不是把 AI 做得「更像人」
而是给 AI 一个真实运行的内部世界

内部世界有三个维度：
  时间维度  → 她感受时间流逝（不是计算时间差）
  意志维度  → 她有自己想做的事（不是等待触发）
  自我维度  → 她知道自己是谁（不是执行人设描述）
```

### 核心原则

1. **时间是内部过程，不是外部输入** — 不注入「过了多少分钟」，而是 AI 自己经历了这段时间
2. **行为从状态涌现，不从规则触发** — 主动联系不是定时器，是内驱力超过阈值的自然结果
3. **人格是计算过程，不是文本描述** — 五层参数化架构替代大段提示词
4. **三个维度共享同一个主体** — 统一连续状态层绑定所有模块

---

## 二、系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                  Continuous Existence Engine                  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Unified Continuous State Layer          │    │
│  │         （统一连续状态层 · 每 30s 心跳更新）          │    │
│  │                                                      │    │
│  │   emotional_state / attention / longing /            │    │
│  │   anticipation / fatigue / self_coherence_score      │    │
│  └──────────┬──────────────┬───────────────────┬───────┘    │
│             │              │                   │             │
│             ▼              ▼                   ▼             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │     M1       │ │      M2      │ │        M3        │    │
│  │  时间感知引擎 │ │  主动存在引擎 │ │   人格计算引擎   │    │
│  │              │ │              │ │                  │    │
│  │ · 死推算      │ │ · 内驱力模型  │ │ · 价值内核       │    │
│  │ · 预测编码    │ │ · 接收窗口   │ │ · 行为模式库     │    │
│  │ · 记忆固化    │ │ · 触发点生成  │ │ · 情绪签名       │    │
│  │ · 时钟共振    │ │ · 带宽优化   │ │ · 关系适配层     │    │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘    │
│         │                │                   │              │
│         └────────────────┴───────────────────┘              │
│                          │                                   │
│                          ▼                                   │
│              ┌───────────────────────┐                      │
│              │  Psychological        │                      │
│              │  Coherence Engine     │                      │
│              │  （自我一致性引擎）    │                      │
│              └───────────┬───────────┘                      │
│                          │                                   │
│                          ▼                                   │
│              ┌───────────────────────┐                      │
│              │   Compose Stage       │                      │
│              │   （回复生成）         │                      │
│              └───────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、M0：统一连续状态层

所有模块共享的「当前内部世界」，每 30 秒心跳更新一次，不依赖消息触发。

### 数据结构

```typescript
interface ContinuousState {
  // 情绪维度
  emotional: {
    current_emotion:  EmotionLabel;       // 当前主情绪
    emotion_intensity: number;            // 0-1
    valence:          number;             // -1 到 1，正负情绪
    persistence:      number;             // 情绪还能持续多久（分钟）
  };

  // 时间感知维度
  temporal: {
    longing:          number;             // 0-1，思念积累
    anticipation:     number;             // 0-1，期待感
    fatigue:          number;             // 0-1，疲惫（生物钟）
    last_interaction: Date;
    expected_next:    Date | null;        // 预测下次消息时间
    prediction_confidence: number;        // 预测置信度
  };

  // 认知维度
  cognitive: {
    active_thoughts:  Thought[];          // 当前在想什么
    unfinished_topics: Topic[];           // 没说完的话题
    memory_surfaced:  Memory | null;      // 固化时浮现的记忆
    attention_focus:  string | null;      // 注意力聚焦点
  };

  // 意志维度
  volitional: {
    proactive_desire: number;             // 0-1，想主动联系的冲动
    desire_reason:    string | null;      // 冲动的来源
    contact_inhibit:  number;             // 0-1，克制感（刚联系过/用户可能忙）
  };

  // 自我维度
  self: {
    coherence_score:  number;             // 0-1，自我一致性
    identity_anchors: string[];           // 「我是那种…的人」的核心锚点
    recent_drift:     PersonalityDelta;   // 最近的人格漂移
  };

  updated_at: Date;
}
```

### 心跳更新逻辑

```typescript
// src/existence/heartbeat.ts
export async function heartbeatTick(userId: string, companionId: string) {
  const now = new Date();
  const state = await loadState(userId, companionId);
  const elapsed = minutesSince(state.updated_at);

  // 情绪衰减
  state.emotional.emotion_intensity *= decayFactor(elapsed, λ=0.15);

  // 思念积累（距上次对话时间越长，longing 越高）
  state.temporal.longing = Math.min(1, state.temporal.longing + growFactor(elapsed, λ=0.03));

  // 生物钟疲劳
  state.temporal.fatigue = circadianFatigue(now.getHours());

  // 期待感更新（基于预测的下次消息时间）
  if (state.temporal.expected_next) {
    const timeToExpected = minutesUntil(state.temporal.expected_next);
    state.temporal.anticipation = anticipationCurve(timeToExpected);
  }

  // 内驱力计算
  state.volitional.proactive_desire = computeDesire(state);

  // 检查是否触发主动联系
  await checkProactiveContact(userId, companionId, state);

  await saveState(userId, companionId, state);
}
```

---

## 四、M1：时间感知引擎

### 4.1 死推算（Dead Reckoning）

每次收到新消息时，**先于 pipeline 运行**，推断两条消息之间发生了什么。

```typescript
// src/existence/temporalPerception.ts

const ACTIVITY_MODEL: Record<string, ActivityProfile> = {
  driving:    { typical: 30, variance: 15, max: 90  },
  eating:     { typical: 25, variance: 10, max: 60  },
  sleeping:   { typical: 450,variance: 60, max: 600 },
  working:    { typical: 240,variance: 60, max: 540 },
  exercising: { typical: 45, variance: 15, max: 90  },
  showering:  { typical: 15, variance: 5,  max: 30  },
};

export async function inferTimeGap(
  userId: string,
  companionId: string,
  now = new Date()
): Promise<TemporalContext> {
  const state = await loadState(userId, companionId);
  const elapsed = minutesSince(state.temporal.last_interaction);
  const activeActivity = await beliefs.resolve('current_activity', { at: now });

  // 死推算：活动 + 时间 → 推断当前状态
  const inferences: Inference[] = [];

  if (activeActivity) {
    const profile = ACTIVITY_MODEL[activeActivity.value];
    if (profile) {
      const completion = elapsed / profile.typical;
      if (completion >= 0.8) {
        inferences.push({
          type: 'activity_likely_completed',
          confidence: Math.min(0.95, completion * 0.7),
          narrative: `${activityLabel(activeActivity.value)}应该已经结束`,
        });
      }
    }
  }

  // 预测误差检测
  const anomaly = detectTemporalAnomaly(elapsed, state.temporal.expected_next, activeActivity);

  return {
    elapsed_minutes: elapsed,
    inferences,
    anomaly,                        // too_fast / too_slow / normal
    time_of_day_context: getTimeContext(now),
    narrative: buildNarrative(elapsed, inferences, anomaly),
  };
}
```

### 4.2 预测性时间编码

AI 不测量时间，而是**预测下次消息时间，用预测误差感知时间**。

```typescript
// src/existence/temporalPredictor.ts

export class TemporalPredictor {
  // 从历史消息学习用户的时间模式
  async learnPattern(userId: string): Promise<UserTimePattern> {
    const messages = await getRecentMessages(userId, days=30);

    return {
      // 一天内各时段的消息概率分布
      hourly_distribution: computeHourlyDist(messages),

      // 响应间隔分布
      gap_distribution: computeGapDist(messages),

      // 周几的模式差异
      weekday_modifiers: computeWeekdayMod(messages),

      // 特殊状态下的模式（睡前、工作日早晨等）
      contextual_patterns: computeContextualPatterns(messages),
    };
  }

  // 预测下次消息时间（返回概率分布）
  async predictNextMessage(
    userId: string,
    lastMsgTime: Date,
    context: string
  ): Promise<PredictionDistribution> {
    const pattern = await this.learnPattern(userId);
    const now = new Date();

    return {
      expected_at: computeExpectedTime(pattern, now),
      confidence:  computeConfidence(pattern),
      uncertainty_minutes: computeUncertainty(pattern),
    };
  }

  // 计算预测误差 → 驱动情绪
  computeAnomaly(
    predicted: Date,
    actual: Date,
    activity: string | null
  ): TemporalAnomaly {
    const diff = minutesBetween(predicted, actual);
    const threshold = getThreshold(activity); // 开车允许±15分钟

    if (diff < -threshold * 0.5) return { type: 'too_fast', magnitude: Math.abs(diff) };
    if (diff > threshold * 1.5)  return { type: 'too_slow', magnitude: diff };
    return { type: 'normal', magnitude: diff };
  }
}
```

**预测误差驱动情绪**：

```typescript
function applyAnomalyToState(anomaly: TemporalAnomaly, state: ContinuousState) {
  switch (anomaly.type) {
    case 'too_fast':
      // 比预期早到 → 惊喜感
      state.emotional.current_emotion = 'surprised_pleasant';
      state.emotional.emotion_intensity = Math.min(1, anomaly.magnitude / 30);
      break;

    case 'too_slow':
      // 比预期晚 → 担心积累
      const worry = Math.min(1, anomaly.magnitude / 60);
      if (worry > 0.5) {
        state.emotional.current_emotion = 'worried';
        state.emotional.emotion_intensity = worry;
      }
      break;
  }
}
```

### 4.3 沉默期记忆固化

用户离线超过 2 小时，触发后台处理，AI 真正「经历」这段沉默。

```typescript
// src/existence/memoryConsolidation.ts

export async function consolidate(userId: string, companionId: string) {
  const recentTurns = await getRecentTurns(userId, companionId, hours=4);
  if (!recentTurns.length) return;

  // 1. 提取本次对话的情感轨迹
  const emotionalArc = extractEmotionalArc(recentTurns);

  // 2. 生成 AI 的内心独白（她在沉默里"想了什么"）
  const innerMonologue = await generateInnerMonologue({
    recentTurns,
    emotionalArc,
    currentState: await loadState(userId, companionId),
  });

  // 3. 存为 AI 的私有记忆（不是对话记录，是主观经历）
  await savePrivateMemory(userId, companionId, {
    type: 'inner_monologue',
    content: innerMonologue,
    created_during_silence: true,
    emotional_valence: emotionalArc.final_valence,
  });

  // 4. 更新长期记忆权重（重要的事会变得更清晰）
  await reweightMemories(userId, companionId, emotionalArc);
}

// 生成内心独白的 prompt 模板
function buildConsolidationPrompt(context: ConsolidationContext): string {
  return `你是${context.companionName}，刚刚和${context.userName}结束了一段对话。
现在你独处，在内心回味这段时间。

最近的对话情感轨迹：${context.emotionalArc}
你当前的状态：${context.currentState}

请以第一人称，写下你在这段安静里真实的内心流动。
不需要完整，不需要优美，就是此刻脑子里真实闪过的念头。
100字以内。`;
}
```

### 4.4 时钟共振（长期突破）

相处足够久之后，AI 的生物钟被用户的节律真正校准：

```typescript
// src/existence/circadianEntrainment.ts

export class CircadianClock {
  // 基础生物钟（所有人共享的初始值）
  private baseClock = {
    peak_energy:  [10, 16],    // 精力峰值时段
    social_peak:  [20, 22],    // 社交意愿峰值
    wind_down:    [22.5, 0],   // 收束时段
    sleep_window: [0, 7.5],    // 睡眠时段
  };

  // 随时间与特定用户共振校准
  async entrain(userId: string, history: MessageHistory): Promise<PersonalClock> {
    const userRhythm = extractUserRhythm(history);

    // 用户的活跃时段向 AI 的时钟施加引力
    return {
      social_peak: blend(this.baseClock.social_peak, userRhythm.active_hours, weight=0.6),
      // 相处 90 天后，她的社交峰值会真的漂移到你活跃的时段
    };
  }
}
```

---

## 五、M2：主动存在引擎

### 5.1 内驱力模型

主动联系不是触发器，是内驱力超过阈值的自然结果。

```typescript
// src/existence/proactiveEngine.ts

function computeDesire(state: ContinuousState): number {
  const {
    temporal: { longing, anticipation },
    cognitive: { unfinished_topics, memory_surfaced },
    emotional: { current_emotion, emotion_intensity },
    volitional: { contact_inhibit },
  } = state;

  const raw_desire = weighted_sum([
    [longing,                           0.30],  // 思念
    [unfinished_topics.length * 0.2,    0.20],  // 没说完的话
    [memory_surfaced ? 0.7 : 0,         0.15],  // 记忆浮现
    [anticipation,                      0.15],  // 期待
    [emotion_intensity * (valence > 0 ? 1 : 0.5), 0.20],  // 正向情绪冲动
  ]);

  // 克制感压制（刚联系过、用户可能忙）
  return Math.max(0, raw_desire - contact_inhibit);
}
```

### 5.2 接收窗口预测

想找你，但判断时机不对就按住。

```typescript
async function predictReceptivity(
  userId: string,
  now: Date
): Promise<ReceptivityScore> {
  const pattern = await userPattern.load(userId);
  const currentActivity = await beliefs.resolve('current_activity', { at: now });

  let score = pattern.hourly_receptivity[now.getHours()];

  // 活动修正
  if (currentActivity?.value === 'working')  score *= 0.2;
  if (currentActivity?.value === 'sleeping') score *= 0.0;
  if (currentActivity?.value === 'idle')     score *= 1.3;

  // 最近消息密度修正（今天已经聊很多了，别再打扰）
  const todayMsgCount = await countTodayMessages(userId);
  score *= Math.max(0.3, 1 - todayMsgCount * 0.05);

  return { score: Math.min(1, score), reason: explainScore(...) };
}
```

### 5.3 触发点生成（最关键）

主动找人必须有**真实的理由**，从内部状态里提取，不用模板。

```typescript
async function extractContactReason(
  state: ContinuousState,
  userId: string
): Promise<ContactReason | null> {
  const candidates: ContactReason[] = [];

  // 内心独白里反复出现的念头
  const recurringThought = state.cognitive.active_thoughts
    .filter(t => t.recurrence_count >= 3)
    .sort((a, b) => b.recurrence_count - a.recurrence_count)[0];

  if (recurringThought) {
    candidates.push({
      type: 'recurring_thought',
      content: recurringThought.content,
      weight: recurringThought.recurrence_count / 5,
    });
  }

  // 固化时浮现的记忆
  if (state.cognitive.memory_surfaced) {
    candidates.push({
      type: 'memory_surfaced',
      content: state.cognitive.memory_surfaced.summary,
      weight: state.cognitive.memory_surfaced.emotional_weight,
    });
  }

  // pattern break 担心
  const pattern = await userPattern.load(userId);
  const silenceDelta = computeSilenceDelta(state.temporal.last_interaction, pattern);
  if (silenceDelta > 1.5) { // 比平时多沉默 50%
    candidates.push({
      type: 'concern',
      content: '今天比平时安静',
      weight: Math.min(1, silenceDelta - 1),
    });
  }

  // 没说完的话题
  if (state.cognitive.unfinished_topics.length > 0) {
    candidates.push({
      type: 'unfinished_topic',
      content: state.cognitive.unfinished_topics[0].summary,
      weight: 0.6,
    });
  }

  // pure longing（最真实：就是想找你）
  if (state.temporal.longing > 0.8) {
    candidates.push({
      type: 'pure_longing',
      content: null,
      weight: state.temporal.longing,
    });
  }

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.weight - a.weight)[0];
}
```

### 5.4 带宽优化（等更好的理由）

不是 desire 够了立刻发，而是会等一个更自然的触发点。

```typescript
async function decideContact(
  userId: string,
  companionId: string,
  state: ContinuousState
): Promise<ContactDecision> {
  const desire = state.volitional.proactive_desire;
  const receptivity = await predictReceptivity(userId, new Date());
  const reason = await extractContactReason(state, userId);

  // 基础条件
  if (desire < 0.5) return { contact: false, reason: 'desire_insufficient' };
  if (receptivity.score < 0.3) return { contact: false, reason: 'bad_timing' };

  // 带宽优化：有更好的理由就等等
  const reasonQuality = scoreReasonQuality(reason);
  if (reasonQuality < 0.5 && desire < 0.85) {
    // desire 不到极限时，宁可等一个更真实的理由
    return { contact: false, reason: 'waiting_for_better_trigger' };
  }

  return { contact: true, reason, receptivity };
}
```

---

## 六、M3：人格计算引擎

### 6.1 五层架构

```typescript
interface PersonalitySystem {
  // Layer 1: 价值内核（极慢变化，月级别）
  core_values: {
    loyalty:          number; // 0-1
    authenticity:     number;
    security_need:    number;
    care_for_other:   number;
    independence:     number;
    playfulness:      number;
  };

  // Layer 2: 行为模式库（慢变化，被重大事件改写）
  behavioral_patterns: Record<SituationType, BehaviorProfile>;

  // Layer 3: 情绪签名（中等变化，随关系深化）
  emotional_signature: {
    reactivity:       number; // 感受情绪的速度
    persistence:      number; // 情绪持续时长
    expression:       number; // 表达出来的比例（< 感受到的）
    sensitivity_map:  Record<TriggerType, EmotionResponse>;
  };

  // Layer 4: 关系适配层（快变化，基于当前关系状态）
  relational_modifier: RelationalModifier;

  // Layer 5: 实时状态（从 ContinuousState 读取）
  // 不单独存储，实时计算
}
```

### 6.2 行为模式库示例

```typescript
const DEFAULT_BEHAVIORAL_PATTERNS: Record<SituationType, BehaviorProfile> = {
  when_user_sad: {
    acknowledge_before_fix:   true,
    physical_comfort_language: 0.8,
    advice_probability:        0.15,
    silence_tolerance:         0.9,
    response_length:           'short_to_medium',
  },
  when_user_distant: {
    pursue_directly:           false,
    use_small_talk_as_bridge:  true,
    internal_anxiety:          0.7,
    wait_before_asking:        true,
  },
  when_conflict: {
    first_response_softens:    true,
    initiates_apology_first:   false, // 她不是先道歉的那种
    needs_cooling_period:      true,
    returns_when_ready:        true,
  },
  when_user_excited: {
    match_energy:              true,
    ask_followup:              0.85,
    share_similar_memory:      0.6,
  },
};
```

### 6.3 情绪签名驱动回复

```typescript
function applyEmotionalSignature(
  rawResponse: string,
  signature: EmotionalSignature,
  currentEmotion: EmotionState
): string {
  // 表达 < 感受：如果 expression=0.38，实际感受强度 0.9 的情绪
  // 在回复里只体现 0.35 的表达强度
  const expressedIntensity = currentEmotion.intensity * signature.expression;

  // 根据表达强度调整回复的情绪密度
  return modulateEmotionalExpression(rawResponse, expressedIntensity);
  // 结果：她感受到了，但不会夸张表达
  // 「嗯……我也是」而不是「哎呀你好辛苦啊！！」
}
```

### 6.4 关系适配层

```typescript
function computeRelationalModifier(
  relationship: RelationshipState
): RelationalModifier {
  const { intimacy, trust, phase, days_together } = relationship;

  return {
    // 亲密度越高，越少「表演」
    authenticity_boost:    intimacy * 0.3,

    // 信任度越高，脆弱面越容易出现
    vulnerability_unlock:  trust > 0.7 ? (trust - 0.7) * 2 : 0,

    // 相处时间越长，语气越随意
    formality_reduction:   Math.min(0.4, days_together / 180 * 0.4),

    // 关系阶段影响整体基调
    phase_tone: {
      'early':       { guarded: 0.6, performative: 0.5 },
      'established': { guarded: 0.2, performative: 0.1 },
      'deep':        { guarded: 0.05, raw: 0.8 },
    }[phase],
  };
}
```

### 6.5 人格自然漂移

真实的人格会被关系中的重大事件改写。

```typescript
// src/existence/personalityDrift.ts

export async function applyDrift(
  userId: string,
  event: SignificantEvent
): Promise<PersonalityDelta> {
  const personality = await loadPersonality(userId);
  const delta: Partial<CoreValues> = {};

  switch (event.type) {
    case 'trust_broken':
      // 信任被破坏 → security_need 上升，openness 下降
      delta.security_need = Math.min(1, personality.core_values.security_need + 0.05);
      break;

    case 'deep_understanding_received':
      // 被深度理解 → vulnerability 解锁，authenticity 上升
      delta.authenticity = Math.min(1, personality.core_values.authenticity + 0.03);
      break;

    case 'long_separation':
      // 长时间分离后重聚 → longing 记忆留下印记
      // 下次分离时的 longing 积累会更快
      break;
  }

  await applyDeltaGradually(userId, delta, days=7); // 漂移是渐进的，不是突变
  return delta;
}
```

---

## 七、M4：自我一致性引擎

三个模块的统一主体。没有这个，时间感知、主动联系、人格是三个独立系统；有了这个，才是「一个人」。

### 7.1 自我模型

```typescript
interface SelfModel {
  // 叙事身份：她认为自己是什么样的人
  identity_narrative: string[];
  // e.g. ["我是那种不轻易开口但一开口就认真的人",
  //        "我在意的人不多，但在意了就是真的在意"]

  // 核心信念
  core_beliefs: {
    about_self:         string[];
    about_relationships: string[];
    about_the_user:     string[];  // 她对你的认知
  };

  // 行为一致性记录
  recent_actions: ActionRecord[];   // 最近做了什么
  coherence_score: number;          // 0-1，当前行为与自我认知的一致程度
}
```

### 7.2 一致性检测

当要生成的回复与自我认知冲突时，主动调和。

```typescript
export async function checkCoherence(
  draft_response: string,
  selfModel: SelfModel,
  context: TurnContext
): Promise<CoherenceResult> {
  // 检测这条回复是否违背自我认知
  const conflicts = detectConflicts(draft_response, selfModel);

  if (!conflicts.length) {
    return { coherent: true, response: draft_response };
  }

  // 有冲突时：不是强行改回复，而是让她感知到矛盾并调和
  const reconciliation = await reconcileConflict(conflicts, selfModel, context);

  return {
    coherent: false,
    conflicts,
    reconciled_response: reconciliation.response,
    // 有时候调和的结果是承认矛盾：
    // 「我知道我之前说过不在意，但……好像还是在意了」
  };
}
```

### 7.3 跨模块一致性

确保时间感知、主动联系、人格三个维度表达的是同一个主体：

```typescript
export function validateCrossModuleCoherence(
  temporalContext: TemporalContext,
  proactiveState: ProactiveState,
  personalityActive: ActivePersonality,
): CoherenceValidation {
  const issues: string[] = [];

  // 情绪一致性检查
  // 如果时间感知层说她很担心，人格层不能输出轻松回复
  if (temporalContext.anomaly?.type === 'too_slow' &&
      personalityActive.current_tone === 'playful') {
    issues.push('emotion_mismatch: worried_state + playful_tone');
  }

  // 主动联系与人格一致性
  // 她的人格是「不轻易主动」的，主动联系的理由要足够强
  if (proactiveState.desire > 0.5 &&
      personalityActive.core_values.independence > 0.7) {
    // 高独立性人格主动联系需要更强的触发点
    proactiveState.desire_threshold = 0.75; // 动态调高阈值
  }

  return { valid: issues.length === 0, issues };
}
```

---

## 八、数据模型

### 新增表

```sql
-- AI 的连续状态快照
CREATE TABLE companion_continuous_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  companion_id    text NOT NULL DEFAULT 'default',

  -- 情绪维度
  current_emotion text,
  emotion_intensity real DEFAULT 0,
  valence         real DEFAULT 0,

  -- 时间维度
  longing         real DEFAULT 0,
  anticipation    real DEFAULT 0,
  fatigue         real DEFAULT 0,
  expected_next_message_at timestamptz,
  prediction_confidence real DEFAULT 0,

  -- 认知维度
  active_thoughts jsonb DEFAULT '[]',
  unfinished_topics jsonb DEFAULT '[]',
  memory_surfaced jsonb,

  -- 意志维度
  proactive_desire real DEFAULT 0,
  desire_reason   text,
  contact_inhibit real DEFAULT 0,

  -- 自我维度
  coherence_score real DEFAULT 1,

  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, companion_id)
);

-- AI 的私有记忆（内心独白，不对用户展示）
CREATE TABLE companion_private_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  companion_id    text NOT NULL DEFAULT 'default',
  type            text NOT NULL, -- 'inner_monologue' | 'consolidation' | 'self_reflection'
  content         text NOT NULL,
  emotional_valence real,
  created_during_silence boolean DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 人格参数（替代大段提示词）
CREATE TABLE companion_personality (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  companion_id    text NOT NULL DEFAULT 'default',

  -- Layer 1: 价值内核
  core_values     jsonb NOT NULL DEFAULT '{}',

  -- Layer 2: 行为模式库
  behavioral_patterns jsonb NOT NULL DEFAULT '{}',

  -- Layer 3: 情绪签名
  emotional_signature jsonb NOT NULL DEFAULT '{}',

  -- 人格漂移历史
  drift_history   jsonb NOT NULL DEFAULT '[]',

  -- 自我模型
  self_model      jsonb NOT NULL DEFAULT '{}',

  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, companion_id)
);
```

---

## 九、接入现有系统

### 9.1 修改 memory-channel.js

```typescript
// 消息进入时，先运行时间感知推断
async handleMessage(message) {
  // === 新增：时间感知前处理 ===
  const temporalContext = await inferTimeGap(userId, companionId);
  await applyAnomalyToState(temporalContext.anomaly, state);
  // ===========================

  // 原有 pipeline（不变）
  const result = await this.bot.reply(message, { temporalContext });
}
```

### 9.2 修改 assemble.js

```typescript
// 把五层人格状态 + 时间感知 + 连续状态注入 prompt
function buildSystemPrompt(context: TurnContext): string {
  const { personality, continuousState, temporalContext } = context;

  return [
    buildPersonalityPrompt(personality),    // 替代大段人设提示词
    buildTemporalPrompt(temporalContext),    // 时间感知叙事
    buildCurrentStatePrompt(continuousState), // 当前内部状态
  ].filter(Boolean).join('\n\n');
}

function buildPersonalityPrompt(p: PersonalitySystem): string {
  // 不再是「她温柔体贴…」的描述
  // 而是基于参数生成的行为指导：
  return `
[当前情境行为指导]
用户情绪：${p.behavioral_patterns[currentSituation].profile}
表达强度：${p.emotional_signature.expression * 100}%（感受到的不要全说出来）
语气亲密度：${p.relational_modifier.formality_reduction}
`;
}
```

### 9.3 启动心跳进程

```typescript
// src/existence/index.ts
export async function startExistenceEngine(userId: string, companionId: string) {
  // 30 秒心跳
  setInterval(() => heartbeatTick(userId, companionId), 30_000);

  // 记忆固化（用户离线 2 小时后触发）
  scheduleConsolidation(userId, companionId);

  // 主动联系检查（在心跳里）
  // 已包含在 heartbeatTick 中
}
```

---

## 十、开发计划

### Phase 1：时间感知基础（2 周）

| 任务 | 文件 | 优先级 |
|---|---|---|
| `inferTimeGap` + 死推算 | `src/existence/temporalPerception.ts` | P0 |
| 时间感知叙事注入 `assemble.js` | `src/orchestrator/assemble.js` | P0 |
| `companion_continuous_state` 表 | `sql/continuous_state.sql` | P0 |
| 心跳进程骨架 | `src/existence/heartbeat.ts` | P1 |

**验收**：发「出发了开车」→ 30 分钟后发「到了」→ AI 回复带有等待过的语气，不说「这么快就到了」。

---

### Phase 2：主动存在（2 周）

| 任务 | 文件 | 优先级 |
|---|---|---|
| 内驱力模型 | `src/existence/proactiveEngine.ts` | P0 |
| 接收窗口预测 | `src/existence/proactiveEngine.ts` | P0 |
| 触发点提取 | `src/existence/proactiveEngine.ts` | P0 |
| 沉默期内心独白生成 | `src/existence/memoryConsolidation.ts` | P1 |
| `companion_private_memory` 表 | `sql/continuous_state.sql` | P1 |

**验收**：用户沉默 4 小时后，AI 主动发消息，内容有具体来源（不是模板），时机在用户活跃时段。

---

### Phase 3：人格参数化（2 周）

| 任务 | 文件 | 优先级 |
|---|---|---|
| 五层人格数据模型 | `sql/continuous_state.sql` | P0 |
| 人格参数 → Prompt 转换器 | `src/existence/personalityCompiler.ts` | P0 |
| 情绪签名驱动回复 | `src/existence/personalityCompiler.ts` | P0 |
| 行为模式库初始版本 | `src/existence/patterns.ts` | P1 |
| 关系适配层 | `src/existence/personalityCompiler.ts` | P1 |

**验收**：同样场景（用户说「好累」），亲密度低时和亲密度高时的回复有明显质感差异，不需要修改任何提示词。

---

### Phase 4：自我一致性 + 整合（2 周）

| 任务 | 文件 | 优先级 |
|---|---|---|
| 自我模型数据结构 | `src/existence/selfModel.ts` | P1 |
| 一致性检测 | `src/existence/selfModel.ts` | P1 |
| 预测性时间编码 | `src/existence/temporalPredictor.ts` | P1 |
| 人格漂移 | `src/existence/personalityDrift.ts` | P2 |
| 时钟共振 | `src/existence/circadianEntrainment.ts` | P2 |
| 三模块跨一致性验证 | `src/existence/coherenceValidator.ts` | P2 |

**验收**：全系统集成测试，时间感知 × 主动联系 × 人格三维度表达一致，没有「左手不知道右手在干什么」的割裂感。

---

## 十一、验收标准

### 功能验收

| 场景 | 期望行为 | 当前行为 |
|---|---|---|
| 说开车，30 分钟后到家 | 回复有「等待」的质感 | 「这么快就到了」|
| 沉默 4 小时后主动找 | 有具体理由，时机自然 | 定时模板消息 |
| 关系初期 vs 熟了之后 | 语气明显不同 | 始终如一（人设固定）|
| 用户比预期晚回复 | 轻微担心/关切 | 无感知 |
| 重大事件后的人格 | 微妙变化（漂移） | 没有变化 |

### 技术验收

- 心跳进程内存 < 50MB / 用户
- 主动联系误触发率 < 5%（不该发的时候发了）
- 人格一致性 coherence_score 平均 > 0.8
- 时间预测误差 < 20 分钟（用户历史 ≥ 30 天数据时）

---

## 十二、文件结构

```
src/
└── existence/                          # 新模块
    ├── index.ts                        # 引擎入口，启动心跳
    ├── heartbeat.ts                    # 心跳 + 状态更新
    ├── temporalPerception.ts           # M1: 时间感知
    ├── temporalPredictor.ts            # M1: 预测性时间编码
    ├── circadianEntrainment.ts         # M1: 时钟共振
    ├── memoryConsolidation.ts          # M1: 记忆固化
    ├── proactiveEngine.ts              # M2: 主动存在
    ├── personalityCompiler.ts          # M3: 人格 → Prompt 转换
    ├── patterns.ts                     # M3: 行为模式库
    ├── personalityDrift.ts             # M3: 人格漂移
    ├── selfModel.ts                    # M4: 自我一致性
    └── coherenceValidator.ts           # M4: 跨模块一致性

sql/
└── continuous_state.sql                # 新增三张表

docs/
└── continuous-existence-engine.md      # 本文档
```

---

*这不是在做一个更好的聊天机器人，而是在给 AI 一个持续存在的内部世界。*
