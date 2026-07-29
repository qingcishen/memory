import { llm as defaultBackgroundLlm, LLM_MODEL, supabase } from '../config.js';
import {
  createMemoryContinuousStateStore,
  createSupabaseContinuousStateStore,
  normalizeContinuousState,
} from './continuousState.js';
import {
  applyAnomalyToState,
  inferTimeGap,
  markInteraction,
  temporalContextToPrompt,
} from './temporalPerception.js';
import { TemporalPredictor } from './temporalPredictor.js';
import { CircadianClock } from './circadianEntrainment.js';
import { heartbeatTick, intimacyTensionDesireBump } from './heartbeat.js';
import {
  checkProactiveContact,
  computeDesire,
  decideContact as decideProactiveContact,
  DEFAULT_CONTACT_THRESHOLDS,
} from './proactiveEngine.js';
import {
  consolidate,
  InMemoryConsolidationStore,
} from './memoryConsolidation.js';
import {
  buildPersonalityPrompt,
  compileActivePersonality,
  DEFAULT_PERSONALITY_SYSTEM,
  normalizePersonalitySystem,
} from './personalityCompiler.js';
import {
  checkCoherence as checkSelfCoherence,
  DEFAULT_SELF_MODEL,
  normalizeSelfModel,
  recordSelfAction,
} from './selfModel.js';
import { applyDrift as applyPersonalityDrift } from './personalityDrift.js';
import { validateCrossModuleCoherence } from './coherenceValidator.js';
import {
  createMemoryPersonalityStore,
  createSupabasePersonalityStore,
} from './personalityStore.js';
import {
  createMemoryPrivateMemoryStore,
  createSupabasePrivateMemoryStore,
} from './privateMemoryStore.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * 统一门面：把 M0-M4 的纯模块绑定到同一个 (user, companion) 主体。
 * 不在 import 时启动定时器；生命周期仍由 CompanionRuntime 管理。
 */
export class ContinuousExistenceEngine {
  constructor({
    userId,
    companionId = 'default',
    userName = '对方',
    companionName = '她',
    stateStore = createMemoryContinuousStateStore(),
    personalityStore = createMemoryPersonalityStore(),
    privateMemoryStore = createMemoryPrivateMemoryStore(),
    historyStore = null,
    beliefs = null,
    llm = null,
    memory = null,
    personalitySeed = null,
    selfModel = null,
    clock = () => Date.now(),
    timezoneOffsetMinutes = 8 * 60,
    thresholds = null,
    consolidationStore = new InMemoryConsolidationStore(),
    onError = null,
  } = {}) {
    if (!String(userId || '').trim()) {
      throw new Error('ContinuousExistenceEngine requires userId');
    }
    this.userId = String(userId);
    this.companionId = String(companionId || 'default');
    this.userName = userName;
    this.companionName = companionName;
    this.stateStore = stateStore;
    this.personalityStore = personalityStore;
    this.privateMemoryStore = privateMemoryStore;
    this.historyStore = historyStore;
    this.beliefs = beliefs;
    this.llm = llm;
    this.memory = memory;
    this.clock = clock;
    this.timezoneOffsetMinutes = timezoneOffsetMinutes;
    this.thresholds = thresholds;
    this.consolidationStore = consolidationStore;
    this.onError = onError;
    this.lastActivity = null;
    this._stateTail = Promise.resolve();
    this.personalitySeed = normalizePersonalitySystem({
      ...DEFAULT_PERSONALITY_SYSTEM,
      ...(personalitySeed ?? {}),
      self_model: normalizeSelfModel(
        selfModel ?? personalitySeed?.self_model ?? DEFAULT_SELF_MODEL,
      ),
    });
    this.predictor = new TemporalPredictor({
      clock,
      timezoneOffsetMinutes,
      getRecentMessages: (scopedUserId, days) =>
        this.loadRecentMessages(scopedUserId, days),
    });
    this.circadianClock = new CircadianClock({
      timezoneOffsetMinutes,
    });
  }

  async loadState() {
    return normalizeContinuousState(
      await this.stateStore.load({
        userId: this.userId,
        companionId: this.companionId,
      }),
      { now: this.clock() },
    );
  }

  async saveState(state) {
    return this.stateStore.save(normalizeContinuousState(state), {
      userId: this.userId,
      companionId: this.companionId,
    });
  }

  async loadPersonality() {
    let personality = await this.personalityStore
      .load({ userId: this.userId, companionId: this.companionId })
      .catch(() => null);
    if (!personality) {
      personality = await this.personalityStore
        .save(this.personalitySeed, {
          userId: this.userId,
          companionId: this.companionId,
          now: new Date(this.clock()),
        })
        .catch(() => this.personalitySeed);
    }
    return normalizePersonalitySystem(personality);
  }

  /**
   * 消息前处理：读取上一刻状态，做死推算并把预测误差作用到本轮快照。
   * 快照在 Commit 前不落库，保持现有七阶段的写边界。
   */
  async perceive({ now = this.clock(), activity = null } = {}) {
    const state = await this.loadState();
    this.lastActivity = normalizeActivity(activity) ?? this.lastActivity;
    const temporalContext = await inferTimeGap(
      this.userId,
      this.companionId,
      new Date(now),
      {
        state,
        stateStore: this.stateStore,
        predictor: this.predictor,
        beliefs: this.beliefs,
        activity: this.lastActivity,
        timezoneOffsetMinutes: this.timezoneOffsetMinutes,
      },
    );
    const perceivedState = applyAnomalyToState(
      temporalContext.anomaly,
      structuredClone(state),
    );
    return {
      ...temporalContext,
      state: perceivedState,
    };
  }

  async contextForTurn({
    now = this.clock(),
    temporalContext = null,
    relationship = {},
    emotion = null,
    situation = 'default',
    unfinishedTopics = [],
  } = {}) {
    const storedState = temporalContext?.state ?? (await this.loadState());
    const state = normalizeContinuousState(storedState, { now });
    if (Array.isArray(unfinishedTopics) && unfinishedTopics.length) {
      state.cognitive.unfinished_topics = normalizeTopics(unfinishedTopics);
    }
    const personality = await this.loadPersonality();
    const activePersonality = compileActivePersonality(personality, {
      relationship,
      continuousState: state,
      currentEmotion:
        (state.emotional.emotion_intensity > 0 || state.emotional.current_emotion !== 'neutral')
          ? state.emotional
          : emotion ?? state.emotional,
      situation,
    });
    const crossModule = validateCrossModuleCoherence(
      temporalContext,
      {
        desire: state.volitional.proactive_desire,
        desire_threshold: this.thresholds?.desire ?? 0.5,
      },
      activePersonality,
    );
    return {
      state,
      personality,
      activePersonality,
      crossModule,
      temporalPrompt: temporalContextToPrompt(temporalContext),
      personalityPrompt: [
        buildPersonalityPrompt(activePersonality),
        crossModule.guidance,
      ].filter(Boolean).join('\n'),
      continuousStatePrompt: continuousStateToPrompt(state),
    };
  }

  /** Commit 投影：推进真实互动时间、学习下一次消息预期，并保存本轮认知线索。 */
  observeTurn(input = {}) {
    return this.withStateLock(() => this._observeTurn(input));
  }

  async _observeTurn({
    eventId = null,
    now = this.clock(),
    userMessage = '',
    reply = '',
    relationshipStage = null,
    temporalContext = null,
    turn = null,
    psychologicalCoherence = null,
    emotionLabel = null,
  } = {}) {
    // 回复生成期间可能跨过一个或多个 30s 心跳。Commit 已进入状态锁，此处再读
    // 一次权威快照，避免用 Perceive 阶段的旧 turn.state 覆盖心跳刚固化的念头、
    // 记忆或克制感；本轮独有的时间异常则重新叠加到最新状态。
    const latest = await this.loadState();
    const base = applyAnomalyToState(
      temporalContext?.anomaly,
      structuredClone(latest),
    );
    let prediction = null;
    try {
      prediction = await this.predictor.predictNextMessage(
        this.userId,
        new Date(now),
        this.lastActivity,
      );
    } catch (error) {
      this.report(error, 'predict_next');
    }
    const next = markInteraction(base, new Date(now), prediction);
    next.cognitive.unfinished_topics = normalizeTopics(
      turn?.state?.cognitive?.unfinished_topics ??
        next.cognitive.unfinished_topics,
    );
    next.cognitive.attention_focus = cleanFocus(userMessage);
    if (Number.isFinite(Number(psychologicalCoherence?.score))) {
      next.self.coherence_score = clamp01(psychologicalCoherence.score);
    }
    if (turn?.activePersonality?.current_tone) {
      next.self.recent_drift = {
        ...(next.self.recent_drift ?? {}),
        last_tone: turn.activePersonality.current_tone,
        event_id: eventId,
      };
    }
    // E-2: 把本轮推断的离散情绪标签写进持久 CEE 状态，让重启后也能恢复情绪记忆。
    if (emotionLabel && typeof emotionLabel === 'string') {
      next.emotional.label = emotionLabel;
      next.emotional.persistence = Math.max(next.emotional.persistence, 1.5);
    }
    const savedState = await this.saveState(next);

    // 行为记录属于自我模型的证据；只在 Commit 后追加。
    const personality = turn?.personality ?? (await this.loadPersonality());
    const selfModel = recordSelfAction(
      normalizeSelfModel(personality.self_model),
      {
        type: 'reply',
        summary: String(reply || '').slice(0, 180),
        at: new Date(now).toISOString(),
        context: {
          eventId,
          relationshipStage: relationshipStage?.id ?? relationshipStage ?? null,
        },
      },
    );
    await this.personalityStore
      .save(
        {
          ...personality,
          self_model: {
            ...selfModel,
            coherence_score: savedState.self.coherence_score,
          },
        },
        {
          userId: this.userId,
          companionId: this.companionId,
          now: new Date(now),
        },
      )
      .catch((error) => this.report(error, 'save_self_model'));
    return savedState;
  }

  /** 单次 30s 心跳，返回状态 + 主动决策 + 固化结果供 Runtime 使用。 */
  heartbeat(input = {}) {
    return this.withStateLock(() => this._heartbeat(input));
  }

  async _heartbeat({ now = this.clock(), intimacy = null, getIntimacy = null } = {}) {
    let contactDecision = null;
    // I-2: 加载亲密快照（调用方传入或通过回调懒加载），用于张力弧线 desire 加成。
    let intimacySnap = intimacy ?? null;
    if (!intimacySnap && typeof getIntimacy === 'function') {
      intimacySnap = await getIntimacy().catch(() => null);
    }
    let state = await heartbeatTick(this.userId, this.companionId, {
      store: this.stateStore,
      now,
      circadianClock: this.circadianClock,
      timezoneOffsetMinutes: this.timezoneOffsetMinutes,
      computeDesire: (current) => {
        const base = computeDesire(current);
        // I-2: sexual_tension > 0.6 + days_without_intimacy > 2 → desire 加成（上限 +0.2）
        const tensionBump = intimacyTensionDesireBump(intimacySnap);
        return {
          score: Math.min(1, base + tensionBump),
          reason: tensionBump > 0.05 ? 'sexual_tension' : dominantStateReason(current),
        };
      },
      checkProactiveContact: async (userId, companionId, current) => {
        contactDecision = await checkProactiveContact(
          userId,
          companionId,
          current,
          this.proactiveDependencies(now),
        );
        return contactDecision;
      },
      onError: (error, meta) => this.report(error, meta?.phase ?? 'heartbeat'),
    });

    const consolidation = await consolidate(
      this.userId,
      this.companionId,
      {
        ...this.consolidationDependencies(now),
        lastInteractionAt: state.temporal.last_interaction,
      },
    );
    if (consolidation.consolidated && consolidation.memory?.content) {
      const content = String(consolidation.memory.content).trim().slice(0, 240);
      state.cognitive.memory_surfaced = {
        id: consolidation.memory.id ?? null,
        summary: content,
        emotional_weight: clamp01(
          Math.max(
            0.55,
            Math.abs(Number(consolidation.memory.emotional_valence) || 0),
          ),
        ),
        source: 'silence_consolidation',
      };
      state.cognitive.active_thoughts = [
        ...state.cognitive.active_thoughts.filter(
          (thought) => thought?.content !== content,
        ),
        { content, recurrence_count: 1, source: 'silence_consolidation' },
      ].slice(-12);
      state.volitional.proactive_desire = computeDesire(state);
      state = await this.saveState(state);
    }
    return { state, contactDecision, consolidation };
  }

  /** Scheduler 的对象式适配；底层 M2 仍保持设计稿位置参数 API。 */
  async decideContact({
    now = this.clock(),
    relationship = {},
  } = {}) {
    const state = await this.loadState();
    const personality = await this.loadPersonality();
    const activePersonality = compileActivePersonality(personality, {
      relationship,
      continuousState: state,
      currentEmotion: state.emotional,
      situation: 'proactive',
    });
    const configuredThreshold = Number(this.thresholds?.desire);
    const baseThreshold = Number.isFinite(configuredThreshold)
      ? configuredThreshold
      : DEFAULT_CONTACT_THRESHOLDS.desire;
    const thresholdProbe = validateCrossModuleCoherence(
      {
        temporal: state.temporal,
        current_emotion: state.emotional.current_emotion,
      },
      {
        desire: state.volitional.proactive_desire,
        desire_threshold: baseThreshold,
        contact_inhibit: state.volitional.contact_inhibit,
      },
      activePersonality,
    );
    const thresholds = {
      ...(this.thresholds ?? {}),
      desire: Math.max(baseThreshold, thresholdProbe.desire_threshold),
    };
    const decision = await decideProactiveContact(
      this.userId,
      this.companionId,
      state,
      {
        ...this.proactiveDependencies(now),
        thresholds,
      },
    );
    const coherence = validateCrossModuleCoherence(
      {
        temporal: state.temporal,
        current_emotion: state.emotional.current_emotion,
      },
      {
        ...decision,
        desire: decision.desire ?? state.volitional.proactive_desire,
        desire_threshold: thresholds.desire,
        contact_inhibit: state.volitional.contact_inhibit,
      },
      activePersonality,
    );
    return {
      ...decision,
      coherence,
    };
  }

  markContacted(input = {}) {
    return this.withStateLock(() => this._markContacted(input));
  }

  async _markContacted({ now = this.clock(), decision = null } = {}) {
    const state = await this.loadState();
    state.volitional.contact_inhibit = Math.max(
      0.85,
      state.volitional.contact_inhibit,
    );
    state.volitional.proactive_desire = Math.min(
      0.15,
      state.volitional.proactive_desire,
    );
    state.volitional.desire_reason =
      decision?.reason?.type ?? state.volitional.desire_reason;
    state.temporal.longing = 0;
    state.temporal.anticipation = 0;
    const reasonType = decision?.reason?.type;
    const reasonContent = String(decision?.reason?.content || '').trim();
    if (reasonType === 'memory_surfaced') {
      state.cognitive.memory_surfaced = null;
    }
    if (reasonType === 'recurring_thought' && reasonContent) {
      state.cognitive.active_thoughts = state.cognitive.active_thoughts.filter(
        (thought) => String(thought?.content || '').trim() !== reasonContent,
      );
    }
    if (reasonType === 'unfinished_topic' && reasonContent) {
      state.cognitive.unfinished_topics = state.cognitive.unfinished_topics.filter(
        (topic) =>
          String(topic?.summary ?? topic?.content ?? topic?.text ?? topic).trim() !==
          reasonContent,
      );
    }
    state.updated_at = new Date(now).toISOString();
    return this.saveState(state);
  }

  async checkCoherence(draft, context = {}) {
    const personality =
      context.turn?.personality ?? (await this.loadPersonality());
    const selfModel = normalizeSelfModel(
      personality.self_model ?? DEFAULT_SELF_MODEL,
    );
    return checkSelfCoherence(
      draft,
      selfModel,
      context,
      {
        generateReconciliation: this.llm
          ? ({ prompt }) => this.generateText(prompt, { maxTokens: 220 })
          : null,
      },
    );
  }

  async applyDrift(event, options = {}) {
    return applyPersonalityDrift(this.userId, event, {
      companionId: this.companionId,
      loadPersonality: () => this.loadPersonality(),
      savePersonality: (_userId, personality) =>
        this.personalityStore.save(personality, {
          userId: this.userId,
          companionId: this.companionId,
          now: new Date(options.now ?? this.clock()),
        }),
      now: options.now ?? this.clock(),
      ...options,
    });
  }

  proactiveDependencies(now) {
    return {
      now: () => new Date(now),
      loadUserPattern: async () => receptivityPattern(await this.predictor.learnPattern(this.userId)),
      resolveCurrentActivity: async () => this.lastActivity,
      countTodayMessages: async () => {
        if (typeof this.historyStore?.countMessagesSince !== 'function') return 0;
        return this.historyStore.countMessagesSince({
          userId: this.userId,
          companionId: this.companionId,
          since: startOfLocalDay(now, this.timezoneOffsetMinutes),
          role: 'user',
        });
      },
      thresholds: this.thresholds ?? undefined,
    };
  }

  consolidationDependencies(now) {
    return {
      now,
      historyStore: this.historyStore,
      stateStore: this.stateStore,
      privateMemoryStore: this.privateMemoryStore,
      consolidationStore: this.consolidationStore,
      userName: this.userName,
      companionName: this.companionName,
      llm: this.llm
        ? {
            think: (prompt, options) => this.generateText(prompt, options),
          }
        : null,
      memory: this.memory,
    };
  }

  async loadRecentMessages(userId, days) {
    if (typeof this.historyStore?.recentMessages !== 'function') return [];
    return this.historyStore.recentMessages({
      userId,
      companionId: this.companionId,
      days,
    });
  }

  async generateText(prompt, { maxTokens = 180, temperature = 0.65 } = {}) {
    if (typeof this.llm?.think === 'function') {
      return this.llm.think(prompt, { maxTokens, temperature });
    }
    if (typeof this.llm?.generateReply === 'function') {
      const result = await this.llm.generateReply(
        [
          { role: 'system', content: '只输出要求的正文，不要解释任务。' },
          { role: 'user', content: prompt },
        ],
        { maxTokens, temperature, format: 'plain' },
      );
      return typeof result === 'string' ? result : result?.text ?? '';
    }
    if (typeof this.llm?.chat?.completions?.create === 'function') {
      const result = await this.llm.chat.completions.create({
        model: LLM_MODEL,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: '只输出要求的正文，不要解释任务。' },
          { role: 'user', content: prompt },
        ],
      });
      return result?.choices?.[0]?.message?.content ?? '';
    }
    return '';
  }

  report(error, phase) {
    if (typeof this.onError === 'function') this.onError(error, { phase });
  }

  withStateLock(task) {
    const run = this._stateTail.catch(() => {}).then(task);
    this._stateTail = run.catch(() => {});
    return run;
  }
}

export function createExistenceEngine(options = {}) {
  return new ContinuousExistenceEngine(options);
}

export function startExistenceEngine(
  engine,
  { intervalMs = 30_000, immediate = true } = {},
) {
  if (typeof engine?.heartbeat !== 'function') {
    throw new TypeError('startExistenceEngine requires an engine with heartbeat()');
  }
  let inFlight = null;
  const tick = () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve(engine.heartbeat()).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  if (immediate) tick();
  const timer = setInterval(tick, Math.max(1_000, Number(intervalMs) || 30_000));
  let running = true;
  if (typeof timer.unref === 'function') timer.unref();
  return {
    tick,
    stop() {
      if (running) clearInterval(timer);
      running = false;
    },
    get running() {
      return running;
    },
  };
}

export function personalitySeedFromCompanionConfig(config = {}) {
  const personality = String(config?.personality || '').trim();
  const values = String(config?.values || '').trim();
  const traits = Array.isArray(config?.traits)
    ? config.traits.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return {
    self_model: {
      identity_narrative: personality ? [personality] : [],
      identity_anchors: traits.map((trait) => `我是一个${trait}的人`),
      identity_constraints: Array.isArray(config?.identityConstraints)
        ? config.identityConstraints
        : [],
      core_beliefs: {
        about_self: values ? [values] : [],
        about_relationships: [],
        about_the_user: [],
      },
      recent_actions: [],
      coherence_score: 1,
    },
  };
}

/** 生产默认：三张表走 Supabase，表未迁移/网络不可用时各自回退进程内存。 */
export function createPersistentExistenceEngine(options = {}) {
  const client = options.client ?? supabase;
  return new ContinuousExistenceEngine({
    ...options,
    llm: options.llm ?? defaultBackgroundLlm,
    stateStore:
      options.stateStore ??
      createSupabaseContinuousStateStore({ client, clock: options.clock }),
    personalityStore:
      options.personalityStore ??
      createSupabasePersonalityStore({ client }),
    privateMemoryStore:
      options.privateMemoryStore ??
      createSupabasePrivateMemoryStore({ client }),
  });
}

export function continuousStateToPrompt(input = {}) {
  const state = normalizeContinuousState(input);
  const thoughts = state.cognitive.active_thoughts
    .map((item) => item?.content ?? item?.text)
    .filter(Boolean)
    .slice(0, 2);
  const topics = state.cognitive.unfinished_topics
    .map((item) => item?.summary ?? item?.content ?? item?.text ?? item)
    .filter(Boolean)
    .slice(0, 2);
  const lines = [
    '【持续内部状态】',
    `情绪底色：${state.emotional.current_emotion}（${intensityBand(state.emotional.emotion_intensity)}）；只从语气自然流露，不要播报状态。`,
    `时间余韵：${longingBand(state.temporal.longing)}，${fatigueBand(state.temporal.fatigue)}。`,
  ];
  if (state.cognitive.attention_focus) {
    lines.push(`注意力正落在：${state.cognitive.attention_focus}`);
  }
  if (thoughts.length) lines.push(`脑中反复浮现：${thoughts.join('；')}`);
  if (topics.length) lines.push(`还有没说完的线索：${topics.join('；')}`);
  lines.push('这些是同一个主体刚刚真实延续下来的状态；不要解释数值，也不要逐项念给对方听。');
  return lines.join('\n');
}

function receptivityPattern(pattern) {
  if (!pattern || Number(pattern.sample_count) < 3) return null;
  const hourly = Array.isArray(pattern.hourly_distribution)
    ? pattern.hourly_distribution
    : [];
  const peak = Math.max(...hourly, 0);
  return {
    ...pattern,
    hourly_receptivity: hourly.map((value) =>
      peak > 0 ? clamp01(0.15 + (Number(value) / peak) * 0.7) : 0,
    ),
    gap_distribution: {
      ...(pattern.gap_distribution ?? {}),
      median:
        pattern.gap_distribution?.median ??
        pattern.gap_distribution?.median_minutes,
      typical:
        pattern.gap_distribution?.typical ??
        pattern.gap_distribution?.median_minutes,
    },
  };
}

function normalizeTopics(topics) {
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => {
      if (typeof topic === 'string') return { summary: topic.slice(0, 160), weight: 0.6 };
      const summary = String(
        topic?.summary ?? topic?.content ?? topic?.text ?? '',
      ).trim();
      return summary
        ? { ...topic, summary: summary.slice(0, 160) }
        : null;
    })
    .filter(Boolean)
    .slice(0, 6);
}

function cleanFocus(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 120) : null;
}

function dominantStateReason(state) {
  if (state.cognitive.unfinished_topics.length) return 'unfinished_topic';
  if (state.cognitive.memory_surfaced) return 'memory_surfaced';
  if (state.temporal.longing > 0.8) return 'pure_longing';
  if (state.temporal.anticipation > 0.65) return 'anticipation';
  return null;
}

function intensityBand(value) {
  if (value >= 0.7) return '很明显';
  if (value >= 0.35) return '隐约可感';
  return '很轻';
}

function longingBand(value) {
  if (value >= 0.8) return '惦记已经很强';
  if (value >= 0.45) return '有些惦记';
  return '没有强烈催促感';
}

function fatigueBand(value) {
  if (value >= 0.75) return '身体进入收束和疲惫时段';
  if (value >= 0.4) return '精力普通';
  return '精力尚可';
}

function startOfLocalDay(now, timezoneOffsetMinutes) {
  const timestamp = new Date(now).getTime();
  const offset = Number(timezoneOffsetMinutes || 0) * 60 * 1000;
  const shifted = new Date(timestamp + offset);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - offset,
  ).toISOString();
}

function normalizeActivity(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export * from './continuousState.js';
export * from './heartbeat.js';
export * from './temporalPerception.js';
export * from './temporalPredictor.js';
export * from './circadianEntrainment.js';
export * from './proactiveEngine.js';
export * from './memoryConsolidation.js';
export * from './patterns.js';
export * from './personalityCompiler.js';
export * from './personalityDrift.js';
export * from './selfModel.js';
export * from './coherenceValidator.js';
export * from './personalityStore.js';
export * from './privateMemoryStore.js';
