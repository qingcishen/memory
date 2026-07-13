// 编排器主体。
//
// reply() = 同步路径: 并行加载状态/记忆 -> (可选)内心独白 -> 组装 prompt -> 生成回复。
// proactiveTick() = 后台主动性入口: 定时器/事件触发 -> 复用同一套 prompt 组装生成主动开场。
// afterReply() = 后台路径: stateLayer.evolve / memory.observe / relationship.bump, allSettled, 不阻塞回复。
// 详见编排器设计方案 §5。

import { MemoryAdapter, StateLayerAdapter, RelationshipAdapter, PersonaAdapter } from './adapters.js';
import { DefaultLLM, normalizeReplyResult, joinReplyParts, pickReplyFormat } from './llm.js';
import { assemble, buildMonologueContext, buildTimePrompt } from './assemble.js';
import { hoursSince } from '../decay.js';
import { getCompanion } from '../companion.js';
import { Selfie, decidePhoto } from '../appearance/index.js';
import { buildNarrationPrompt } from '../narration.js';
import { PARAMS } from '../params.js';
import { inferEmotionLabel, emotionLabelToPrompt } from '../state/emotionLabel.js';
import {
  emptyEmotionResidue,
  normalizeEmotionResidue,
  serializeEmotionResidue,
  seedResidueFromStoryBeat,
} from '../state/emotionResidue.js';
import { resonateFromMemoryHits, applyResonanceToEmotion } from '../state/emotionResonance.js';
import { residueToDesireEvent } from '../state/emotionDesireBridge.js';
import {
  emptyEmotionJournal,
  normalizeEmotionJournal,
  appendEmotionEvent,
  shouldLogEmotionTransition,
  emotionJournalToPrompt,
} from '../state/emotionJournal.js';
import { emotionDecayOverridesFromConfig } from '../state/affect.js';
import { fuseEmotionPrompt } from '../emotion.js';
import { behaviorPolicy, behaviorToPrompt } from '../state/behavior.js';
import { StoryEngine } from '../story/index.js';
import { buildConversationGoals, goalsToPrompt } from './goals.js';
import { prepareIntimacyForTurn, defaultIntimacy, mergeIntimacyConfig } from '../state/intimacy.js';
import { normalizeWardrobe } from '../state/outfit.js';
import { detectSceneLocks, sceneCoherenceToPrompt, extractUnfinishedHooks, nonSequiturRepairHint } from '../companion/sceneCoherence.js';
import { inferRelationshipStage, relationshipStageToPrompt, applyStageToBehavior } from '../companion/relationshipStage.js';
import { buildEpisodeHeuristic, episodesToPrompt, synthesizeEpisodeChain } from '../companion/episode.js';
import { buildProactiveContentPack, PROACTIVE_STYLE_GUIDE } from '../companion/proactiveContent.js';
import { inferBodySituation, bodyStateToPrompt, applyBodyToBehavior, bodyIntimacyGate } from '../companion/bodyState.js';
import {
  planTurn,
  applyBehaviorSampling,
  enforcePartsBudget,
  stripStockEndingsFromParts,
} from './turnPlan.js';
import { explainRecallHits, formatRecallExplanation } from './explainRecall.js';
import {
  planStructuredHeuristic,
  enrichStructuredPlan,
  applyStructuredToTurn,
  structuredPlanToPrompt,
} from './structuredPlan.js';
import {
  synthesizeRelationshipNarrative,
  relationshipNarrativeToPrompt,
  readRelationshipNarrative,
  saveRelationshipNarrative,
} from '../companion/relationshipNarrative.js';
import {
  emptySessionThread,
  updateSessionThread,
  sessionThreadToPrompt,
  sessionHooksToUnfinished,
  shouldResetSession,
  detectSessionDrift,
  normalizeSessionThread,
  serializeSessionThread,
  rebuildSessionThreadFromHistory,
} from '../companion/sessionThread.js';
import { readUserProfilePrompt } from '../profile.js';

const DEFAULT_HISTORY_TURNS = 6;

// 用户在话里要看她的样子/照片 (触发自拍)。
const PHOTO_REQUEST_RE = /自拍|拍(张|个|一)?照|照片|你长(啥|什么)样|看看你(长|现在|的样子)?|发(张|个)?(图|照)|想看你|你现在(啥|什么)样/;

export class Orchestrator {
  /**
   * @param companionId 多角色隔离键 (默认 'default'); 同一 userId 下不同 companionId 数据互不可见。
   * @param companionName 显示名/称呼; 不显式传时由 companions 表里的 CompanionConfig.name 覆盖。
   * @param config 可选: 预加载好的 CompanionConfig; 不传则 init() 时按 (userId, companionId) 从 companions 表拉。
   * @param deps 可注入 { memory, stateLayer, relationship, persona, llm, historyStore }, 默认用真实适配器。
   * @param options { useMonologue=true, historyTurns=6 }
   */
  constructor({ userId, companionId = 'default', subjectName = '对方', companionName = '她', config = null, activityFn = null, lifeConfig = null, deps = {}, options = {} }) {
    if (!userId) throw new Error('Orchestrator 需要 userId');
    this.userId = userId;
    this.companionId = companionId;
    this.subjectName = subjectName;
    this.companionName = companionName;
    this._companionNameExplicit = companionName !== '她'; // 显式传过就别被 config.name 覆盖
    this._config = config;
    this.options = {
      useMonologue: true,
      historyTurns: DEFAULT_HISTORY_TURNS,
      personaRefreshMs: PARAMS.orchestrator.personaRefreshMs,
      ...options,
    };

    // 先建状态层, 再把它内部的 LifeDimension / IntimacyDimension 注入记忆适配器 ——
    // 让 memory.observe 与状态层共用同一实例 (L4 身心耦合 + I 线亲密演变, 避免双写)。
    this.stateLayer =
      deps.stateLayer ??
      new StateLayerAdapter(userId, companionId, null, {
        activityFn,
        lifeConfig,
        intimacyBaseline: config?.intimacyBaseline ?? null,
        intimacyHardBoundaries: config?.intimacyHardBoundaries ?? null,
        intimacyConfig: {
          ...mergeIntimacyConfig(PARAMS.intimacy, config?.intimacyDrive),
          ...(config?.intimacyKnowledge ? { knowledge: config.intimacyKnowledge } : {}),
        },
        outfitWardrobe: config?.outfitWardrobe ?? null,
      });
    const sharedLife = this.stateLayer?.stateLayer?.life ?? null;
    const sharedDesire = this.stateLayer?.stateLayer?.desire ?? null;
    const sharedIntimacy = this.stateLayer?.stateLayer?.intimacy ?? null;
    const sharedOutfit = this.stateLayer?.stateLayer?.outfit ?? null;
    this.memory =
      deps.memory ??
      new MemoryAdapter({
        userId,
        companionId,
        subjectName,
        companionName,
        life: sharedLife,
        desire: sharedDesire,
        intimacy: sharedIntimacy,
        outfit: sharedOutfit,
      });
    this.relationship = deps.relationship ?? new RelationshipAdapter(userId, companionId);
    this.persona = deps.persona ?? new PersonaAdapter({ userId, companionId, subjectName: companionName });
    this.llm = deps.llm ?? new DefaultLLM();
    this.historyStore = deps.historyStore ?? null;

    // A1 拍照分享 (自拍 + 随手拍): 需要 onPhoto 投递回调才会启用 —— 没有投递渠道就不生成,
    // 这也让全 mock 的编排器测试默认离线 (不注入 onPhoto 即跳过)。photo 能力默认用真实 Selfie。
    this.photo = deps.photo ?? new Selfie({ userId, companionId, provider: deps.imageProvider });
    this.onPhoto = deps.onPhoto ?? null;
    this.afterReplyEnqueue = deps.afterReplyEnqueue ?? null;
    // 天气感知 (可选): 注入了才拉真实天气并进 prompt; 默认 null → 离线安全 (mock 测试不连网)。
    this.weather = deps.weather ?? null;
    // 世界观系统 (可选): 注入 WorldDimension 才有背景剧情线/氛围并随对话演变; 默认 null → 离线安全。
    this.world = deps.world ?? null;
    // 旁白系统 (可选): 注入 SceneClassifier 才按场景动态给旁白指令; 默认 null → 离线安全, 不额外调 LLM。
    this.narration = deps.narration ?? null;
    this.story = deps.story ?? null;
    this._storyProvided = Object.prototype.hasOwnProperty.call(deps, 'story');
    this._storySeeded = false;

    this.history = [];
    this._personaLoadedAt = 0;
    this._historyLoaded = false;
    this._configLoaded = false;
    this._relationshipNarrative = '';
    this._userProfilePrompt = '';
    this._residentSlotsLoadedAt = 0;
    this._episodeBuffer = [];
    this._lastStructured = null;
    this._lastTurnPlan = null;
    this._sessionThread = emptySessionThread();
    this._emotionResidue = emptyEmotionResidue();
    this._emotionJournal = emptyEmotionJournal();
  }

  /**
   * 加载/刷新人格段 (IO); reply() 会自动调用。
   * 首次总会加载; 之后每隔 personaRefreshMs 重新加载一次, 让长期运行的实例
   * (如 ProactiveScheduler 反复复用同一个 Orchestrator) 能感知到 self 记忆的更新。
   */
  async init() {
    const now = Date.now();
    // 多角色: 首次 init 时加载 CompanionConfig (名字/外貌/说话风格/性格)。
    // 没显式传 companionName 时用 config.name 作称呼; 外貌等补充随 persona 段注入 (方案 A)。
    if (!this._configLoaded) {
      // 只在 persona 适配器支持 setExtra (= 真实 PersonaAdapter) 时才去 companions 表拉配置;
      // 全 mock 的编排器测试不带 setExtra, 因此保持离线、零 DB 调用。显式传入的 config 始终生效。
      if (!this._config && typeof this.persona?.setExtra === 'function') {
        this._config = await getCompanion(this.userId, this.companionId).catch(() => null);
      }
      if (this._config) {
        if (!this._companionNameExplicit && this._config.name) {
          this.companionName = this._config.name;
          if (this.persona) this.persona.subjectName = this.companionName;
        }
        if (this.persona && typeof this.persona.setExtra === 'function') {
          this.persona.setExtra(buildPersonaExtra(this._config));
        }
        // 只在这个 (user, companion) 还没有任何 affective_state 记录时生效一次, 见 RelationshipAdapter.seedIfNew。
        if (typeof this.relationship?.seedIfNew === 'function') {
          await this.relationship.seedIfNew(this._config);
        }
        // E3 人设气质 → 衰减半衰期/基线
        const emoOv = emotionDecayOverridesFromConfig(this._config);
        if (emoOv && this.stateLayer?.stateLayer?.setEmotionDecayOverrides) {
          this.stateLayer.stateLayer.setEmotionDecayOverrides(emoOv);
        } else if (emoOv && typeof this.stateLayer?.setEmotionDecayOverrides === 'function') {
          this.stateLayer.setEmotionDecayOverrides(emoOv);
        }
        // I 线: 配置加载后把人设基线/硬边界/欲望 drive 挂到共享 IntimacyDimension
        const intimacyDim = this.stateLayer?.stateLayer?.intimacy;
        if (intimacyDim && this._config) {
          if (this._config.intimacyBaseline) intimacyDim.baseline = this._config.intimacyBaseline;
          if (this._config.intimacyHardBoundaries?.length) intimacyDim.hardBoundaries = this._config.intimacyHardBoundaries;
          if (this._config.intimacyDrive || this._config.intimacyKnowledge) {
            intimacyDim.config = {
              ...mergeIntimacyConfig(PARAMS.intimacy, this._config.intimacyDrive),
              ...(this._config.intimacyKnowledge ? { knowledge: this._config.intimacyKnowledge } : {}),
            };
            if (this._config.intimacyKnowledge) intimacyDim.knowledge = this._config.intimacyKnowledge;
          }
          if (this._config.intimacyEnabled === false && intimacyDim.config) {
            intimacyDim.config = { ...intimacyDim.config, enabled: false };
          }
        }
        // O 线: 衣橱目录挂到 OutfitDimension
        const outfitDim = this.stateLayer?.stateLayer?.outfit;
        if (outfitDim && this._config?.outfitWardrobe) {
          outfitDim.wardrobe = normalizeWardrobe(this._config.outfitWardrobe);
        }
        if (!this._storyProvided && (this._config.storyCast?.length || this._config.storylines?.length)) {
          this.story = new StoryEngine({
            userId: this.userId, companionId: this.companionId, companionName: this.companionName,
            cast: this._config.storyCast, lines: this._config.storylines, memory: this.memory,
            desire: this.stateLayer?.stateLayer?.desire ?? null,
            onStoryBeat: (beat) => this.applyStoryBeatToEmotion(beat),
          });
        }
      }
      this._configLoaded = true;
    }
    if (this.story && !this._storySeeded && typeof this.story.seed === 'function') {
      await this.story.seed().catch(() => {});
      this._storySeeded = true;
    }
    if (!this._personaLoadedAt || now - this._personaLoadedAt >= this.options.personaRefreshMs) {
      if (typeof this.persona.load === 'function') await this.persona.load().catch(() => {});
      this._personaLoadedAt = now;
    }
    if (!this._historyLoaded) {
      await this.loadHistory().catch(() => {});
      this._historyLoaded = true;
    }
    if (!this._anniversariesEnsured && typeof this.memory.ensureAnniversaries === 'function') {
      await this.memory.ensureAnniversaries().catch(() => {});
      this._anniversariesEnsured = true;
    }
    // 关系周记 / 用户画像常驻槽（失败静默，mock 测试不连库）
    await this.loadResidentSlots().catch(() => {});
    return this;
  }

  /**
   * 加载跨会话常驻槽：【我们最近】关系周记 + 【她眼中的你】用户画像。
   * 与 persona 同刷新周期；PARAMS.orchestrator.residentSlots === false 时跳过。
   */
  async loadResidentSlots({ force = false } = {}) {
    if (PARAMS.orchestrator?.residentSlots === false) {
      this._relationshipNarrative = '';
      this._userProfilePrompt = '';
      return this;
    }
    const now = Date.now();
    const ttl = this.options.personaRefreshMs ?? PARAMS.orchestrator?.personaRefreshMs ?? 30 * 60 * 1000;
    if (!force && this._residentSlotsLoadedAt && now - this._residentSlotsLoadedAt < ttl) return this;

    // 与 companions 配置加载同门：全 mock 编排器测试（persona 无 setExtra）不连库。
    // 真实 PersonaAdapter / 显式 forceResidentSlots 才读周记与画像。
    const canHitDb =
      this.options.forceResidentSlots === true || typeof this.persona?.setExtra === 'function';
    if (!canHitDb) {
      this._residentSlotsLoadedAt = now;
      return this;
    }

    const [narrative, profilePrompt] = await Promise.all([
      readRelationshipNarrative(this.userId, this.companionId).catch(() => ''),
      readUserProfilePrompt(this.userId, this.companionId).catch(() => ''),
    ]);
    if (narrative) this._relationshipNarrative = narrative;
    if (profilePrompt) this._userProfilePrompt = profilePrompt;
    this._residentSlotsLoadedAt = now;
    return this;
  }

  /** 从可选 historyStore 拉最近短期历史 + 会话线; 默认内存版什么也不做。 */
  async loadHistory() {
    if (!this.historyStore || typeof this.historyStore.load !== 'function') return this.history;
    const limit = this.options.historyTurns * 2;
    const loaded = await this.historyStore.load({ userId: this.userId, companionId: this.companionId, limit });
    if (Array.isArray(loaded)) {
      this.history = normalizeHistory(loaded).slice(-limit);
      this.trimHistory();
    }
    await this.loadSessionThread().catch(() => {});
    await this.loadEmotionResidue().catch(() => {});
    return this.history;
  }

  async loadEmotionResidue() {
    let raw = null;
    if (this.historyStore && typeof this.historyStore.loadEmotionResidue === 'function') {
      raw = await this.historyStore
        .loadEmotionResidue({ userId: this.userId, companionId: this.companionId })
        .catch(() => null);
    }
    this._emotionResidue = raw ? normalizeEmotionResidue(raw) : emptyEmotionResidue();
    this._emotionJournal = normalizeEmotionJournal(raw?.journal);
    return this._emotionResidue;
  }

  persistEmotionResidue() {
    if (!this.historyStore || typeof this.historyStore.saveEmotionResidue !== 'function') return Promise.resolve();
    const residue = serializeEmotionResidue(this._emotionResidue);
    const journal = normalizeEmotionJournal(this._emotionJournal);
    this._lastEmotionPersist = Promise.resolve(
      this.historyStore.saveEmotionResidue({
        userId: this.userId,
        companionId: this.companionId,
        residue,
        journal,
      }),
    ).catch((reason) => {
      console.error('[historyStore.emotion]', reason);
    });
    return this._lastEmotionPersist;
  }

  /** 标签变化时记 journal + residual→desire 耦合 */
  applyEmotionSideEffects(prevResidue, nextResidue, { userMessage = '', source = 'turn' } = {}) {
    const prev = normalizeEmotionResidue(prevResidue);
    const next = normalizeEmotionResidue(nextResidue);
    if (shouldLogEmotionTransition(prev.label, next.label, prev.intensity, next.intensity)) {
      this._emotionJournal = appendEmotionEvent(this._emotionJournal, {
        fromLabel: prev.label,
        toLabel: next.label,
        intensity: next.intensity,
        cause: userMessage || next.cause,
        source,
        at: Date.now(),
      });
    }
    this._emotionResidue = next;
    // desire bridge（异步，不阻塞）
    const desireEvent = residueToDesireEvent(next);
    if (desireEvent) {
      const dim = this.stateLayer?.stateLayer?.desire ?? this.stateLayer?.desire;
      if (dim && typeof dim.accumulate === 'function') {
        const { reason, ...deltas } = desireEvent;
        this._lastDesireBridge = Promise.resolve(dim.accumulate(deltas)).catch(() => null);
      }
    }
  }

  /** 故事 beat 软种子 residual（maintain/story 回调） */
  applyStoryBeatToEmotion(beat) {
    const prev = this._emotionResidue;
    const { residual, changed, event } = seedResidueFromStoryBeat(prev, beat, Date.now());
    if (changed && event) {
      this.applyEmotionSideEffects(prev, residual, { userMessage: event.cause, source: 'story' });
      this.persistEmotionResidue();
    }
    return residual;
  }

  /**
   * 加载本场会话线：优先 historyStore 快照；否则从短期历史重建。
   * 超时（4h）则空会话。
   */
  async loadSessionThread() {
    if (PARAMS.orchestrator?.sessionThread === false) {
      this._sessionThread = emptySessionThread();
      return this._sessionThread;
    }
    let raw = null;
    if (this.historyStore && typeof this.historyStore.loadSessionThread === 'function') {
      raw = await this.historyStore
        .loadSessionThread({ userId: this.userId, companionId: this.companionId })
        .catch(() => null);
    }
    let thread = raw ? normalizeSessionThread(raw) : null;
    if (!thread || !thread.turnCount) {
      // 冷启动：从已 load 的 history 重建
      if (this.history?.length) {
        thread = rebuildSessionThreadFromHistory(this.history);
      } else {
        thread = emptySessionThread();
      }
    }
    if (shouldResetSession(thread)) thread = emptySessionThread();
    this._sessionThread = thread;
    return this._sessionThread;
  }

  /** 异步持久化会话线（失败只打日志） */
  persistSessionThread() {
    if (PARAMS.orchestrator?.sessionThread === false) return Promise.resolve();
    if (!this.historyStore || typeof this.historyStore.saveSessionThread !== 'function') return Promise.resolve();
    const thread = serializeSessionThread(this._sessionThread);
    this._lastSessionPersist = Promise.resolve(
      this.historyStore.saveSessionThread({
        userId: this.userId,
        companionId: this.companionId,
        thread,
      }),
    ).catch((reason) => {
      console.error('[historyStore.session]', reason);
    });
    return this._lastSessionPersist;
  }

  /** 只保留最近 historyTurns 轮(user+assistant 各一条)。 */
  trimHistory() {
    const max = this.options.historyTurns * 2;
    if (this.history.length > max) this.history = this.history.slice(-max);
  }

  /** 写入实例内短期历史, 并把增量异步交给可选 historyStore。 */
  recordHistory(turns = [], meta = {}) {
    const clean = normalizeHistory(turns);
    if (clean.length === 0) return;
    this.history.push(...clean);
    this.trimHistory();
    if (this.historyStore && typeof this.historyStore.append === 'function') {
      this._lastHistoryPersist = Promise.resolve(this.historyStore.append({ userId: this.userId, companionId: this.companionId, turns: clean, ...meta })).catch((reason) => {
        console.error('[historyStore]', reason);
      });
    }
  }

  /**
   * 一轮对话主入口: 加载状态+记忆 -> (可选)内心独白 -> 组装 -> 生成回复。
   * 任一子系统加载失败都降级为空, 不影响回复 (见编排器设计方案 §9)。
   */
  async reply(userMessage, opts = {}) {
    await this.init();
    // 长时间沉默后清历史: 若距上次用户发言超过 4 小时, 旧消息时间背景与当前严重错位,
    // 清掉旧历史让 LLM 按系统提示的当前时间重新建立上下文, 防止它被几小时前的对话带偏。
    const idleHours = this._lastUserMessageAt ? (Date.now() - this._lastUserMessageAt) / 3600000 : 0;
    if (idleHours >= 4 && this.history.length > 0) {
      this.history = [];
      this._lastSceneType = null; // 隔了这么久, 场景连续性提示也该重新开始判断, 不该沿用几小时前的场景
      this._sessionThread = emptySessionThread(); // 新会话线
      this.persistSessionThread();
    }
    // 会话线超时重置（即使 history 已空）
    if (PARAMS.orchestrator?.sessionThread !== false && shouldResetSession(this._sessionThread)) {
      this._sessionThread = emptySessionThread();
      this.persistSessionThread();
    }
    this._lastUserMessageAt = Date.now();

    // 先并行拉状态/场景；记忆召回用 turnPlan 增强 query，故分两段（状态极快，不显著增延迟）
    const [stateSnapshot, relState, weather, worldSnapshot, storySnapshot, dueItems, sceneType, lastUserMessageAt] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
      this.weather ? this.weather.current().catch(() => '') : Promise.resolve(''),
      this.world ? this.world.current().catch(() => null) : Promise.resolve(null),
      this.story ? this.story.current().catch(() => null) : Promise.resolve(null),
      typeof this.memory.checkProspective === 'function' ? this.memory.checkProspective({ query: userMessage }).catch(() => []) : Promise.resolve([]),
      this.narration ? this.narration.classify({ userMessage, history: this.history, previousScene: this._lastSceneType, signal: opts.signal }).catch(() => 'daily') : Promise.resolve('daily'),
      this.historyStore && typeof this.historyStore.lastUserMessageAt === 'function'
        ? this.historyStore.lastUserMessageAt({ userId: this.userId, companionId: this.companionId }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const gapHours = lastUserMessageAt != null ? hoursSince(lastUserMessageAt) : null;
    const recoverBias =
      emotionDecayOverridesFromConfig(this._config)?.recoverBias ??
      this.stateLayer?.stateLayer?.emotionDecayOverrides?.recoverBias;
    const emotionInferred = inferEmotionLabel(
      { ...(stateSnapshot ?? {}), relationship: relState?.relationship ?? relState ?? {} },
      stateSnapshot?.desires,
      [...this.history.slice(-4), { role: 'user', content: userMessage }],
      {
        previousResidual: this._emotionResidue,
        userMessage,
        recoverBias,
        withResidual: true,
        now: Date.now(),
      },
    );
    const emotionLabel = typeof emotionInferred === 'string' ? emotionInferred : emotionInferred.label;
    if (emotionInferred && typeof emotionInferred === 'object' && emotionInferred.residual) {
      const prevRes = this._emotionResidue;
      this.applyEmotionSideEffects(prevRes, emotionInferred.residual, { userMessage, source: 'turn' });
    }
    this._lastEmotionLabel = emotionLabel;
    // I2: 回复前预演亲密阶段（不写库），驱动旁白细分与 prompt 指引
    const intimacyLive =
      PARAMS.intimacy?.enabled !== false
        ? prepareIntimacyForTurn(
            stateSnapshot?.intimacy ?? defaultIntimacy(),
            {
              userMessage,
              sceneType,
              relationship: relState?.relationship ?? relState ?? stateSnapshot?.relationship,
              life: stateSnapshot?.life,
              desires: stateSnapshot?.desires,
            },
            this.stateLayer?.stateLayer?.intimacy?.config ?? PARAMS.intimacy
          )
        : stateSnapshot?.intimacy ?? null;
    const stateForPrompt = stateSnapshot ? { ...stateSnapshot, intimacy: intimacyLive ?? stateSnapshot.intimacy } : stateSnapshot;
    const rel = relState?.relationship ?? relState ?? {};
    const relStage = inferRelationshipStage(rel);
    const bodySit = inferBodySituation(stateSnapshot?.life, this._config?.profile?.menstrual);
    let behavior = behaviorPolicy(emotionLabel, { relationship: rel, ...(opts.behaviorState ?? {}) });
    behavior = applyStageToBehavior(behavior, relStage);
    behavior = applyBodyToBehavior(behavior, bodySit);
    // 场景连贯锁（纯逻辑）：从历史+本轮+亲密阶段推断，注入最高优先级 prompt
    const sceneLocks = detectSceneLocks(userMessage, this.history, intimacyLive?.scene_phase);
    this._lastSceneLocks = sceneLocks;
    // 会话线 peek：仅用户句预览（不写回），合并历史未完钩子 + 本场问题/约定
    const sessionPeek =
      PARAMS.orchestrator?.sessionThread === false
        ? null
        : updateSessionThread(this._sessionThread, {
            userMessage,
            sceneLocks,
            now: Date.now(),
          });
    const unfinished = [
      ...extractUnfinishedHooks(this.history),
      ...(sessionPeek ? sessionHooksToUnfinished(sessionPeek) : []),
    ].slice(0, 4);
    // 故事 beat：今日 + 未分享的 pending 都可作内容源
    let storyBeat = storySnapshot?.today ?? null;
    if (!storyBeat && typeof this.story?.pendingShare === 'function') {
      storyBeat = await this.story.pendingShare().catch(() => null);
    }
    const goals = buildConversationGoals({
      dueItems,
      desires: stateSnapshot?.desires,
      storyBeat,
      intimacy: intimacyLive ?? stateSnapshot?.intimacy,
      intimacyPolicy: this.stateLayer?.stateLayer?.intimacy?.config?.proactive,
      unfinished,
      outfit: stateSnapshot?.outfit,
      userMessage,
      sceneLocks,
    });
    // 身体门控：病中/经期时砍掉高主动亲密意图
    const bodyGate = bodyIntimacyGate(bodySit);
    if (!bodyGate.allowIntimateInit) {
      for (const g of goals) {
        if (g.kind === 'intimacy' && g.canInitiate) {
          g.canInitiate = false;
          g.text = '身体不适：可黏可要抱抱，别主动推高热；对方坚持也温柔设限。';
          g.priority = Math.min(g.priority, 0.35);
        }
      }
      goals.sort((a, b) => b.priority - a.priority);
    }
    // 产品安全门：停止词 / 亲密关闭（来自 Telegram/飞书/UI 的 gateIncomingMessage）
    if (opts.stopIntimate || opts.intimacyAllowed === false) {
      for (const g of goals) {
        if (g.kind === 'intimacy') {
          g.canInitiate = false;
          g.text = opts.stopIntimate
            ? '对方已表示停止/冷静：立刻降热，先确认边界，不继续身体推进。'
            : '当前亲密内容策略关闭：保持情感陪伴，不进入高热描写。';
          g.priority = 0.95;
        }
      }
      goals.unshift({
        kind: 'safety',
        priority: 1,
        text: opts.stopIntimate
          ? '安全停止：承认并停下亲密推进，语气稳、给台阶，别质问。'
          : '亲密策略限制中：正常聊天即可。',
      });
      goals.sort((a, b) => b.priority - a.priority);
    }

    // 本轮计划：历史深度 / 独白 / 召回 query / parts 预算 / 简报
    let turn = planTurn({
      userMessage,
      sceneLocks,
      behavior,
      goals,
      intimacyPhase: intimacyLive?.scene_phase,
      bodySit,
      gapHours,
      historyTurnsDefault: this.options.historyTurns ?? DEFAULT_HISTORY_TURNS,
      useMonologueDefault: this.options.useMonologue,
    });
    // 两阶段：结构化决策（启发式 + 可选便宜模型）
    let structured = planStructuredHeuristic({
      userMessage,
      sceneLocks,
      goals,
      behavior,
      storyBeat,
      unfinished,
      intimacyPhase: intimacyLive?.scene_phase,
      bodySit,
    });
    // enrich：仅真实 LLM 客户端（OpenAI 兼容）才二次规划；DefaultLLM mock / 无 client 跳过
    const planClient = this.llm?.client || this.llm?.openai || null;
    if (PARAMS.orchestrator?.structuredPlanLlm !== false && planClient) {
      structured = await enrichStructuredPlan(
        structured,
        {
          userMessage,
          sceneLocks,
          goals,
          storyBeat,
          unfinished,
          intimacyPhase: intimacyLive?.scene_phase,
        },
        { client: planClient, signal: opts.signal },
      ).catch(() => structured);
    }
    turn = applyStructuredToTurn(turn, structured, behavior);
    if (turn._lengthHintOverride) {
      behavior = { ...behavior, lengthHint: turn._lengthHintOverride, partsBudget: turn.partsBudget };
    }
    if (turn.replyFormat) opts = { ...opts, replyFormat: opts.replyFormat || turn.replyFormat };
    this._lastTurnPlan = turn;
    this._lastStructured = structured;

    if (this.narration) this._lastSceneType = sceneType;
    this._lastSceneTypeForObserve = sceneType;
    if (typeof this.memory.setSceneType === 'function') this.memory.setSceneType(sceneType);

    // B3: Telegram 明确要求执行 stonewall 时，不生成一条永远不会送达的假回复，也不把它写进历史。
    if (opts.executeStonewall && behavior.stonewall) {
      this.recordHistory([{ role: 'user', content: userMessage }], { eventId: opts.eventId });
      this._lastAfterReply = this.afterReply(userMessage, '');
      return { text: '', parts: [], emotionLabel, behaviorPolicy: behavior };
    }

    const askAboutDay = /(今天|最近|最近在忙|怎么样|过得|忙什么)/.test(userMessage);
    // 先拼「无记忆」上下文，独白与召回并行（降延迟突破）
    const promptBase = {
      timePrompt: buildTimePrompt(new Date(), { weather, gapHours }),
      personaPrompt: this.persona.toPrompt() ?? '',
      worldPrompt: this.world ? this.world.toPrompt(worldSnapshot) : '',
      storyPrompt: this.story
        ? this.story.toPrompt(storySnapshot, { forceToday: Boolean(storyBeat) || askAboutDay })
        : '',
      identityConstraintsPrompt: buildIdentityConstraints(this._config),
      relationshipPrompt: this.relationship.toPrompt(relState) ?? '',
      relationshipStagePrompt: relationshipStageToPrompt(relStage, rel),
      coherencePrompt: sceneCoherenceToPrompt(sceneLocks, {
        intimacyPhase: intimacyLive?.scene_phase,
        topGoalText: goals[0]?.text,
      }),
      turnBriefPrompt: turn.turnBrief || '',
      structuredPlanPrompt: structuredPlanToPrompt(structured),
      relationshipNarrativePrompt:
        PARAMS.orchestrator?.residentSlots === false
          ? ''
          : relationshipNarrativeToPrompt(this._relationshipNarrative || ''),
      userProfilePrompt: PARAMS.orchestrator?.residentSlots === false ? '' : this._userProfilePrompt || '',
      sessionThreadPrompt: sessionPeek ? sessionThreadToPrompt(sessionPeek) : '',
      statePrompt: [
        // StateLayer 真实现会融合 label；mock adapter 无 ctx 时下面再补 emotionLabelToPrompt
        this.stateLayer.toPrompt(stateForPrompt, {
          relationship: rel,
          hardBoundaries: this._config?.intimacyHardBoundaries,
          intimacyConfig: this.stateLayer?.stateLayer?.intimacy?.config,
          emotionLabel,
          emotionResidual: this._emotionResidue,
        }),
        ...(typeof this.stateLayer?.stateLayer?.toPrompt === 'function'
          ? []
          : [emotionLabelToPrompt(emotionLabel, this._emotionResidue)]),
        PARAMS.emotion?.journal?.enabled !== false
          ? emotionJournalToPrompt(this._emotionJournal, PARAMS.emotion?.journal?.promptLimit ?? 2)
          : '',
        bodyStateToPrompt(bodySit, intimacyLive ?? stateSnapshot?.intimacy),
        behaviorToPrompt(behavior),
      ]
        .filter(Boolean)
        .join('\n\n'),
      goalsPrompt: goalsToPrompt(goals),
      narrationPrompt: this.narration
        ? buildNarrationPrompt(sceneType, this._config?.narrationDirectives, emotionLabel, intimacyLive?.scene_phase)
        : intimacyLive && ['foreplay', 'peak', 'aftercare', 'flirting'].includes(intimacyLive.scene_phase)
          ? buildNarrationPrompt(sceneType === 'daily' ? 'intimate' : sceneType, this._config?.narrationDirectives, emotionLabel, intimacyLive.scene_phase)
          : '',
    };

    // 短轮可对 prompt 做轻量瘦身（少塞世界线/长故事）
    const compact = PARAMS.orchestrator?.compactShortTurns !== false && userMessage.trim().length <= 12 && !sceneLocks.length;
    if (compact) {
      if (promptBase.worldPrompt && promptBase.worldPrompt.length > 200) promptBase.worldPrompt = '';
      if (promptBase.storyPrompt && !askAboutDay) promptBase.storyPrompt = promptBase.storyPrompt.slice(0, 180);
    }

    const monologuePromise = turn.useMonologue
      ? this.llm
          .think(buildMonologueContext({ userMessage, ...promptBase, memoryBlock: '' }), {
            signal: opts.signal,
            maxTokens: PARAMS.orchestrator.monologueMaxTokens,
          })
          .catch(() => '')
      : Promise.resolve('');

    const memoryPromise = this.memory
      .recall(turn.recallQuery || userMessage, { debug: Boolean(opts.debug) })
      .catch(() => '');

    const [monologue, memoryResult] = await Promise.all([monologuePromise, memoryPromise]);
    const memoryBlock = memoryResult && typeof memoryResult === 'object' && 'block' in memoryResult ? memoryResult.block : memoryResult;
    const memoryHits = memoryResult && typeof memoryResult === 'object' && Array.isArray(memoryResult.hits) ? memoryResult.hits : [];
    const episodeTexts = extractEpisodeTexts(memoryHits);
    const recallExplain = explainRecallHits(memoryHits, turn.recallQuery || userMessage);

    // E4 触景生情：只扰动本轮展示 emotion，重写 statePrompt 中的情绪段
    const resonance = resonateFromMemoryHits(memoryHits, stateSnapshot?.emotion);
    if (resonance && promptBase.statePrompt) {
      const emoShow = applyResonanceToEmotion(stateSnapshot?.emotion || {}, resonance);
      const fused = fuseEmotionPrompt(emoShow, emotionLabel, this._emotionResidue, emotionLabelToPrompt);
      // 用融合段替换原 toEmotionPrompt 开头（简单：前缀注入触景提示）
      promptBase.statePrompt = [
        fused,
        resonance.reasons?.length
          ? `【触景余味】想起了：${resonance.reasons[0]}。只让语气轻轻偏一点，别说「我想起了某条记忆」。`
          : '',
        promptBase.statePrompt,
      ]
        .filter(Boolean)
        .join('\n\n');
      this._lastResonance = resonance;
    }

    const promptParts = {
      ...promptBase,
      episodePrompt: episodesToPrompt(episodeTexts),
      memoryBlock: memoryBlock ?? '',
    };

    const messages = assemble({
      userMessage,
      history: this.history,
      historyTurns: turn.historyTurns,
      ...promptParts,
      monologue,
    });

    const baseSampling =
      typeof this.stateLayer.samplingHints === 'function' && stateSnapshot ? this.stateLayer.samplingHints(stateSnapshot) : {};
    const samplingHints = applyBehaviorSampling(baseSampling, behavior, bodySit);
    // 日常 plain 更快首包；亲密/车内/有旁白指令 → json
    const replyFormat = pickReplyFormat({
      sceneLocks,
      intimacyPhase: intimacyLive?.scene_phase,
      needNarration: Boolean(promptParts.narrationPrompt && promptParts.narrationPrompt.trim()),
      forceFormat: opts.replyFormat,
    });
    samplingHints.format = replyFormat;

    // 流式路径：调用方 for await 消费；非流式保持原语义
    if (opts.stream && typeof this.llm.generateReplyStream === 'function') {
      return this._replyStreaming({
        userMessage,
        opts,
        messages,
        samplingHints,
        turn,
        structured,
        sceneLocks,
        stateSnapshot,
        stateForPrompt,
        relState,
        relStage,
        bodySit,
        unfinished,
        worldSnapshot,
        storySnapshot,
        storyBeat,
        sceneType,
        emotionLabel,
        behavior,
        goals,
        memoryHits,
        recallExplain,
        promptParts,
        monologue,
        intimacyLive,
      });
    }

    let { text: reply, parts } = normalizeReplyResult(
      await this.llm.generateReply(messages, { ...samplingHints, signal: opts.signal })
    );

    // 一致性检改：默认开启（params.orchestrator.coherenceRetry）
    const allowRetry = opts.skipCoherenceRetry !== true && PARAMS.orchestrator?.coherenceRetry !== false;
    const repair = nonSequiturRepairHint(reply, sceneLocks);
    if (repair.needsRetry && allowRetry) {
      try {
        const retryMessages = [
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: repair.hint },
        ];
        const retried = normalizeReplyResult(
          await this.llm.generateReply(retryMessages, { ...samplingHints, signal: opts.signal })
        );
        if (retried?.text && !nonSequiturRepairHint(retried.text, sceneLocks).needsRetry) {
          reply = retried.text;
          parts = retried.parts;
        }
      } catch {
        /* 保持原稿 */
      }
    }

    ({ reply, parts } = this._postProcessParts(reply, parts, turn, sceneLocks));

    // 会话线落盘：用户句 + 她的回复（含她的承诺）→ 持久化
    if (PARAMS.orchestrator?.sessionThread !== false) {
      this._sessionThread = updateSessionThread(this._sessionThread, {
        userMessage,
        reply,
        sceneLocks,
        now: Date.now(),
      });
      this.persistSessionThread();
    }
    this.persistEmotionResidue();

    this.recordHistory([
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply },
    ], { eventId: opts.eventId });

    this._lastAfterReply = this.afterReply(userMessage, reply, {
      history: this.history,
      sceneLocks,
      relationshipStage: relStage,
    });

    // 动作计划：对方要看 / structured 决策 wantPhoto
    if (PHOTO_REQUEST_RE.test(userMessage) || structured?.wantPhoto) {
      this._lastPhoto = this.maybePhoto(stateSnapshot, { requested: PHOTO_REQUEST_RE.test(userMessage) || structured?.wantPhoto });
    }

    const sessionDrift = detectSessionDrift(reply, this._sessionThread);
    const debug = opts.debug
      ? this._buildDebug({
          stateForPrompt,
          intimacyLive,
          relState,
          relStage,
          bodySit,
          sceneLocks,
          unfinished,
          turn,
          structured,
          repair,
          sessionDrift,
          worldSnapshot,
          storySnapshot,
          storyBeat,
          sceneType,
          emotionLabel,
          behavior,
          goals,
          memoryHits,
          recallExplain,
          promptParts,
          monologue,
          messages,
          samplingHints,
        })
      : undefined;
    return {
      text: reply,
      parts,
      emotionLabel,
      behaviorPolicy: behavior,
      goals,
      intimacyPhase: intimacyLive?.scene_phase ?? null,
      relationshipStage: relStage?.id ?? null,
      sceneLocks: sceneLocks.map((l) => l.id),
      bodySituation: bodySit,
      recallExplain,
      turnPlan: summarizeTurnPlan(turn),
      structuredPlan: summarizeStructured(structured),
      sessionThread: summarizeSessionThread(this._sessionThread),
      emotionResidue: this._emotionResidue
        ? { label: this._emotionResidue.label, intensity: this._emotionResidue.intensity }
        : null,
      ...(debug ? { debug } : {}),
    };
  }

  /**
   * 流式回复：async generator。yield 与 llm.generateReplyStream 相同事件，最后附带完整 result 字段。
   * for await (const ev of orch.replyStream(msg)) { if (ev.event==='preview') ... if (ev.event==='done') ... }
   */
  async *replyStream(userMessage, opts = {}) {
    // async reply() 在 stream:true 时 resolve 为一个 async generator
    const gen = await this.reply(userMessage, { ...opts, stream: true });
    if (gen && typeof gen[Symbol.asyncIterator] === 'function') {
      yield* gen;
      return;
    }
    // 降级：非流式结果
    const result = gen;
    yield { event: 'preview', text: result?.text || '' };
    yield { event: 'done', ...result, streamed: false };
  }

  async *_replyStreaming(ctx) {
    const {
      userMessage, opts, messages, samplingHints, turn, structured, sceneLocks, stateSnapshot,
      emotionLabel, behavior, goals, intimacyLive, relStage, bodySit, recallExplain,
    } = ctx;
    let lastPreview = '';
    let finalParts = [];
    let finalText = '';
    let streamed = true;
    let repair = { needsRetry: false, reasons: [] };

    try {
      for await (const ev of this.llm.generateReplyStream(messages, { ...samplingHints, signal: opts.signal })) {
        if (ev.event === 'delta' || ev.event === 'preview') {
          if (ev.event === 'preview') lastPreview = ev.text || lastPreview;
          yield ev;
        } else if (ev.event === 'done') {
          finalParts = ev.parts || [];
          finalText = ev.text || joinReplyParts(finalParts);
          streamed = ev.streamed !== false;
        }
      }
    } catch {
      const full = normalizeReplyResult(
        await this.llm.generateReply(messages, { ...samplingHints, signal: opts.signal })
      );
      finalParts = full.parts;
      finalText = full.text;
      streamed = false;
      yield { event: 'preview', text: finalText };
    }

    let reply = finalText;
    let parts = finalParts;

    // 流式完成后一致性检改（默认同非流式）
    const allowRetry = opts.skipCoherenceRetry !== true && PARAMS.orchestrator?.coherenceRetry !== false;
    repair = nonSequiturRepairHint(reply, sceneLocks);
    if (repair.needsRetry && allowRetry) {
      try {
        const retryMessages = [
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: repair.hint },
        ];
        const retried = normalizeReplyResult(
          await this.llm.generateReply(retryMessages, { ...samplingHints, signal: opts.signal })
        );
        if (retried?.text && !nonSequiturRepairHint(retried.text, sceneLocks).needsRetry) {
          reply = retried.text;
          parts = retried.parts;
          yield { event: 'preview', text: reply };
        }
      } catch {
        /* 保持原稿 */
      }
    }

    ({ reply, parts } = this._postProcessParts(reply, parts, turn, sceneLocks));

    if (PARAMS.orchestrator?.sessionThread !== false) {
      this._sessionThread = updateSessionThread(this._sessionThread, {
        userMessage,
        reply,
        sceneLocks,
        now: Date.now(),
      });
      this.persistSessionThread();
    }
    this.persistEmotionResidue();

    this.recordHistory(
      [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: reply },
      ],
      { eventId: opts.eventId },
    );
    this._lastAfterReply = this.afterReply(userMessage, reply, {
      history: this.history,
      sceneLocks,
      relationshipStage: relStage,
    });
    if (PHOTO_REQUEST_RE.test(userMessage) || structured?.wantPhoto) {
      this._lastPhoto = this.maybePhoto(stateSnapshot, {
        requested: PHOTO_REQUEST_RE.test(userMessage) || structured?.wantPhoto,
      });
    }

    const result = {
      text: reply,
      parts,
      emotionLabel,
      behaviorPolicy: behavior,
      goals,
      intimacyPhase: intimacyLive?.scene_phase ?? null,
      relationshipStage: relStage?.id ?? null,
      sceneLocks: sceneLocks.map((l) => l.id),
      bodySituation: bodySit,
      recallExplain,
      turnPlan: summarizeTurnPlan(turn),
      structuredPlan: summarizeStructured(structured),
      sessionThread: summarizeSessionThread(this._sessionThread),
      emotionResidue: this._emotionResidue
        ? { label: this._emotionResidue.label, intensity: this._emotionResidue.intensity }
        : null,
      streamed,
    };
    if (opts.debug) {
      result.debug = this._buildDebug({
        ...ctx,
        structured,
        repair,
        messages,
        monologue: ctx.monologue,
        samplingHints,
      });
    }
    yield { event: 'done', ...result };
  }

  _postProcessParts(reply, parts, turn, sceneLocks) {
    let p = parts;
    let r = reply;
    if (PARAMS.orchestrator?.enforcePartsBudget !== false) {
      p = enforcePartsBudget(p, turn.partsBudget);
      r = joinReplyParts(p);
    }
    if (PARAMS.orchestrator?.stripStockEndings !== false) {
      const stripped = stripStockEndingsFromParts(p, sceneLocks);
      if (stripped !== p) {
        p = stripped;
        r = joinReplyParts(p);
      }
    }
    return { reply: r, parts: p };
  }

  _buildDebug({
    stateForPrompt,
    intimacyLive,
    relState,
    relStage,
    bodySit,
    sceneLocks,
    unfinished,
    turn,
    structured,
    repair,
    sessionDrift,
    worldSnapshot,
    storySnapshot,
    storyBeat,
    sceneType,
    emotionLabel,
    behavior,
    goals,
    memoryHits,
    recallExplain,
    promptParts,
    monologue,
    messages,
    samplingHints,
  }) {
    return {
      stateSnapshot: stateForPrompt,
      intimacyPhase: intimacyLive?.scene_phase ?? null,
      relationshipState: relState,
      relationshipStage: relStage,
      bodySituation: bodySit,
      sceneLocks: (sceneLocks || []).map((l) => l.id),
      unfinished,
      turnPlan: summarizeTurnPlan(turn),
      structuredPlan: summarizeStructured(structured ?? this._lastStructured),
      sessionThread: summarizeSessionThread(this._sessionThread),
      sessionDrift: sessionDrift?.drift ? sessionDrift.reasons : [],
      emotionResidue: this._emotionResidue,
      emotionJournal: this._emotionJournal?.slice?.(-5) || [],
      emotionResonance: this._lastResonance || null,
      relationshipNarrative: this._relationshipNarrative || '',
      userProfilePrompt: this._userProfilePrompt || '',
      recallExplain: recallExplain || [],
      recallExplainText: formatRecallExplanation(recallExplain || [], turn?.recallQuery),
      coherenceRepair: repair?.needsRetry ? repair.reasons : [],
      worldSnapshot,
      storySnapshot,
      storyBeat,
      sceneType,
      emotionLabel,
      behaviorPolicy: behavior,
      goals,
      memoryHits: (memoryHits || []).map(({ embedding, media_embedding, ...m }) => m),
      promptParts,
      monologue,
      messages,
      samplingHints,
      historyTurns: turn?.historyTurns,
    };
  }

  /**
   * 主动性入口: 由外部定时器/事件判断后调用。它只负责复用编排器组装 prompt 并生成主动开场,
   * 防打扰、作息、频率控制等策略由调用方或 ctx.shouldSend 提供。
   * @returns {Promise<string|null>} 不该发送时返回 null。
   */
  async proactiveTick(ctx = {}) {
    await this.init();

    const shouldSend =
      typeof ctx.shouldSend === 'function'
        ? await ctx.shouldSend({ userId: this.userId, history: this.history, ctx })
        : ctx.shouldSend ?? true;
    if (!shouldSend) return null;

    const [stateSnapshot, relState, weather, worldSnapshot, storySnapshot] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
      this.weather ? this.weather.current().catch(() => '') : Promise.resolve(''),
      this.world ? this.world.current().catch(() => null) : Promise.resolve(null),
      this.story ? this.story.current().catch(() => null) : Promise.resolve(null),
    ]);

    const pack =
      ctx.contentPack ||
      buildProactiveContentPack({
        dueItems: ctx.dueItems,
        urgency: ctx.urgency,
        intimacyUrg: ctx.intimacyUrg,
        storyBeat: ctx.storyBeat ?? storySnapshot?.today,
        outfit: stateSnapshot?.outfit,
        unfinished: ctx.unfinished ?? extractUnfinishedHooks(this.history),
        silenceTier: ctx.silenceTier,
        bedtimeTier: ctx.bedtimeTier,
        lifeActivity: stateSnapshot?.life?.current_activity,
        life: stateSnapshot?.life,
        defaultReason: ctx.reason ?? activityReason(stateSnapshot?.life) ?? '想主动找对方聊一句',
        emotionLabel: this._emotionResidue?.label || this._lastEmotionLabel || null,
        emotionResidue: this._emotionResidue,
      });
    const effCtx = {
      ...ctx,
      reason: ctx.reason ?? pack.reason,
      query: ctx.query ?? pack.query,
      style: ctx.style ?? pack.style,
      contentPack: pack,
    };

    const rel = relState?.relationship ?? relState ?? {};
    const relStage = inferRelationshipStage(rel);
    const bodySit = inferBodySituation(stateSnapshot?.life, this._config?.profile?.menstrual);
    const emotionLabel = inferEmotionLabel(
      { ...(stateSnapshot ?? {}), relationship: rel },
      stateSnapshot?.desires,
      this.history.slice(-4),
    );
    let behavior = behaviorPolicy(emotionLabel, { relationship: rel });
    behavior = applyStageToBehavior(behavior, relStage);
    behavior = applyBodyToBehavior(behavior, bodySit);

    // 与 reply 同一套 turnPlan（主动消息用内容包 reason 当「用户句」）
    const pseudoUser = String(effCtx.query || effCtx.reason || '想找你聊一句');
    const turn = planTurn({
      userMessage: pseudoUser,
      sceneLocks: [],
      behavior,
      goals: [{ kind: 'proactive', text: pack.reason, priority: 1 }],
      bodySit,
      historyTurnsDefault: this.options.historyTurns ?? DEFAULT_HISTORY_TURNS,
      useMonologueDefault: ctx.useMonologue ?? this.options.useMonologue,
    });
    // 主动消息默认更短
    turn.partsBudget = Math.min(turn.partsBudget, 2);
    turn.historyTurns = Math.min(turn.historyTurns, 4);
    this._lastTurnPlan = turn;

    const seed = turn.recallQuery || effCtx.query || effCtx.reason || '想主动找对方聊一句';
    const memoryResult = await this.memory.recall(seed, { debug: false }).catch(() => '');
    const memoryBlock = memoryResult && typeof memoryResult === 'object' && 'block' in memoryResult ? memoryResult.block : memoryResult;

    const promptParts = {
      timePrompt: buildTimePrompt(new Date(), { weather }),
      personaPrompt: this.persona.toPrompt() ?? '',
      worldPrompt: this.world ? this.world.toPrompt(worldSnapshot) : '',
      storyPrompt: this.story ? this.story.toPrompt(storySnapshot) : '',
      identityConstraintsPrompt: buildIdentityConstraints(this._config),
      relationshipPrompt: this.relationship.toPrompt(relState) ?? '',
      relationshipStagePrompt: relationshipStageToPrompt(relStage, rel),
      relationshipNarrativePrompt:
        PARAMS.orchestrator?.residentSlots === false
          ? ''
          : relationshipNarrativeToPrompt(this._relationshipNarrative || ''),
      userProfilePrompt: PARAMS.orchestrator?.residentSlots === false ? '' : this._userProfilePrompt || '',
      sessionThreadPrompt:
        PARAMS.orchestrator?.sessionThread === false
          ? ''
          : sessionThreadToPrompt(this._sessionThread),
      turnBriefPrompt: turn.turnBrief || '',
      statePrompt: [
        this.stateLayer.toPrompt(stateSnapshot) ?? '',
        bodyStateToPrompt(bodySit, stateSnapshot?.intimacy),
        behaviorToPrompt(behavior),
      ]
        .filter(Boolean)
        .join('\n\n'),
      memoryBlock: memoryBlock ?? '',
    };

    let monologue = '';
    if (turn.useMonologue) {
      const situation = buildProactiveSituation(effCtx);
      monologue = await this.llm
        .think(buildMonologueContext({ situation, ...promptParts }), {
          maxTokens: PARAMS.orchestrator.monologueMaxTokens,
        })
        .catch(() => '');
    }

    const messages = assemble({
      userMessage: buildProactiveInstruction(effCtx),
      history: this.history,
      historyTurns: turn.historyTurns,
      ...promptParts,
      monologue,
    });

    const baseSampling =
      typeof this.stateLayer.samplingHints === 'function' && stateSnapshot ? this.stateLayer.samplingHints(stateSnapshot) : {};
    const samplingHints = applyBehaviorSampling(baseSampling, behavior, bodySit);
    let { text: proactive, parts } = normalizeReplyResult(await this.llm.generateReply(messages, samplingHints));
    ({ reply: proactive, parts } = this._postProcessParts(proactive, parts, turn, []));

    if (ctx.recordHistory !== false) this.recordHistory([{ role: 'assistant', content: proactive }]);

    this._lastPhoto = this.maybePhoto(stateSnapshot, {});

    return {
      text: proactive,
      parts,
      contentPack: pack,
      relationshipStage: relStage?.id ?? null,
      turnPlan: {
        historyTurns: turn.historyTurns,
        useMonologue: turn.useMonologue,
        recallQuery: turn.recallQuery,
        partsBudget: turn.partsBudget,
      },
    };
  }

  /**
   * A1: 此刻要不要拍照分享 —— 自拍(她自己) 或随手拍(她看到的风景/猫狗)。
   * 需要 onPhoto 投递回调才会跑 (没投递渠道就不生成); 全程 fire-and-forget, 不阻塞文字回复。
   * @returns 生成的 { url, tags, kind, reason } 或 null
   */
  async maybePhoto(snapshot, ctx = {}) {
    if (!this.onPhoto || !snapshot) return null;
    const rateState = await this.photo.rateState().catch(() => ({ sentAt: [] }));
    const decision = decidePhoto(snapshot, { ...ctx, rateState });
    if (!decision.ok) return null;
    const result = await this.photo
      .photo(snapshot, { kind: decision.kind, appearance: this._config?.appearance ?? '' })
      .catch(() => null);
    if (!result) return null;
    await Promise.resolve(this.onPhoto({ ...result, reason: decision.reason })).catch((e) => console.error('[onPhoto]', e));
    return result;
  }

  /**
   * 维护期 (后台定时, 无对话时也跑): 让她的内在自行演变/沉淀。
   * - 常规: settle(心情随时间回落) + tickActivity(作息活动派生 + 自动生病判定)。
   * - nightly: 额外 reflect(归纳印象) + story(我们的故事) + dedupe(合并近义重复) + train(M9 每日训练)。
   * 任一失败只记日志, 互不影响。
   */
  async maintain({ now = Date.now(), nightly = false } = {}) {
    const tasks = [];
    if (typeof this.memory.settle === 'function') tasks.push(this.memory.settle(now));
    if (typeof this.stateLayer.tickActivity === 'function') tasks.push(this.stateLayer.tickActivity());
    if (nightly) {
      if (typeof this.memory.reflect === 'function') tasks.push(this.memory.reflect());
      if (typeof this.memory.updateUserProfile === 'function') tasks.push(this.memory.updateUserProfile());
      if (typeof this.memory.story === 'function') tasks.push(this.memory.story());
      if (typeof this.memory.dedupe === 'function') tasks.push(this.memory.dedupe());
      if (typeof this.memory.train === 'function') tasks.push(this.trainNightly());
      // Episode 夜间：把当日缓冲篇章合成关系故事链
      tasks.push(this.synthesizeEpisodesNightly(now));
      // 关系周记常驻槽刷新
      if (PARAMS.orchestrator?.residentSlots !== false) {
        tasks.push(this.refreshRelationshipNarrativeNightly(now));
      }
    }
    const results = await Promise.allSettled(tasks);
    // S2 故事拍在基础 settle 完成后再推进，避免两条 affect 写路径并发覆盖。
    if (nightly && typeof this.story?.tick === 'function') {
      results.push(...await Promise.allSettled([this.story.tick({ now })]));
    }
    // 夜间后强制刷新常驻槽缓存（画像可能已被 updateUserProfile 更新）
    if (nightly && PARAMS.orchestrator?.residentSlots !== false) {
      results.push(...await Promise.allSettled([this.loadResidentSlots({ force: true })]));
    }
    for (const r of results) if (r.status === 'rejected') console.error('[maintain]', r.reason);
    return results;
  }

  /**
   * 夜间启发式合成关系周记并落库；失败静默。
   */
  async refreshRelationshipNarrativeNightly(now = Date.now()) {
    const [relState, stateSnapshot, storySnapshot] = await Promise.all([
      this.relationship.current().catch(() => null),
      this.stateLayer.snapshot().catch(() => null),
      this.story?.current?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    const rel = relState?.relationship ?? relState ?? {};
    const stage = inferRelationshipStage(rel);
    const episodes = (this._episodeBuffer || []).slice(-3);
    const text = synthesizeRelationshipNarrative({
      stage,
      relationship: rel,
      storyBeat: storySnapshot?.today,
      episodes,
      life: stateSnapshot?.life,
    });
    if (!text) return null;
    this._relationshipNarrative = text;
    // 真实 persona 适配器才落库；mock 测试只更新内存槽
    const canHitDb =
      this.options.forceResidentSlots === true || typeof this.persona?.setExtra === 'function';
    if (canHitDb) {
      const saved = await saveRelationshipNarrative(this.userId, this.companionId, text).catch(() => null);
      if (!saved && typeof this.memory.recordSelfEvent === 'function') {
        await this.memory.recordSelfEvent(`【关系周记】${text}`, { importance: 8, narrative: text }).catch(() => null);
      }
    }
    return text;
  }

  /**
   * 夜间把缓冲的篇章启发式合成「关系故事链」写入 dyad episode。
   * 无缓冲则从近期 history 抽一条。
   */
  async synthesizeEpisodesNightly(now = Date.now()) {
    const buffer = this._episodeBuffer || [];
    this._episodeBuffer = [];
    let chain = null;
    if (buffer.length >= 1) {
      chain = synthesizeEpisodeChain(buffer, { label: new Date(now).toISOString().slice(0, 10) });
    } else if (this.history?.length >= 4) {
      const ep = buildEpisodeHeuristic(this.history.slice(-16), { now });
      if (ep) chain = synthesizeEpisodeChain([ep], { label: new Date(now).toISOString().slice(0, 10) });
    }
    if (!chain) return null;
    if (typeof this.memory.recordEpisode === 'function') return this.memory.recordEpisode(chain);
    if (typeof this.memory.recordSelfEvent === 'function') {
      return this.memory.recordSelfEvent(chain.content, { narrative: chain.title, importance: chain.importance });
    }
    return null;
  }

  /**
   * M9 每日训练: 拼好当下人格/状态/关系段, 交给 memory.train 做知识滴灌 + 自我日记 (见 src/training.js)。
   * 没有模型微调——"训练"落地为往 self 记忆里慢慢补充新内容, 让人设/情感的连续性随时间展开。
   */
  async trainNightly() {
    await this.init().catch(() => {});
    const [stateSnapshot, relState] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
    ]);
    return this.memory.train({
      knowledgeBank: this._config?.knowledgeBank ?? [],
      llm: this.llm,
      promptCtx: {
        personaPrompt: this.persona.toPrompt() ?? '',
        statePrompt: this.stateLayer.toPrompt(stateSnapshot) ?? '',
        relationshipPrompt: this.relationship.toPrompt(relState) ?? '',
      },
    });
  }

  /** 回复返回后触发的后台状态更新, 任一失败只记日志, 不影响已发出的回复。 */
  afterReply(userMessage, reply, meta = {}) {
    if (this.afterReplyEnqueue) {
      return Promise.resolve(this.afterReplyEnqueue({ userMessage, reply, ...meta }))
        .catch((error) => {
          console.error('[afterReply.enqueue]', error);
          return this.runAfterReply(userMessage, reply, meta);
        });
    }
    return this.runAfterReply(userMessage, reply, meta);
  }

  /** 真正执行回复后状态更新，供持久队列 worker 调用。 */
  runAfterReply(userMessage, reply, meta = {}) {
    const turns = [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply },
    ];
    const tasks = [this.stateLayer.evolve(turns), this.memory.observe(turns), this.relationship.bump()];
    // 世界观系统: 后台判断这一轮要不要推进世界线 (大多数寻常对话不推进, 见 WorldDimension.evolve)。
    if (this.world) tasks.push(this.world.evolve(turns));
    // Episode · 会话篇章：历史够长时落一条 dyad 叙事记忆（启发式，不改 fact_core）
    if (typeof this.memory.recordEpisode === 'function' || typeof this.memory.recordSelfEvent === 'function') {
      tasks.push(this.maybeRecordEpisode(meta.history ?? this.history, turns));
    }
    return Promise.allSettled(tasks).then((results) => {
      for (const r of results) if (r.status === 'rejected') console.error('[afterReply]', r.reason);
      return results;
    });
  }

  /**
   * 从最近对话抽篇章；每 N 轮最多落一条，避免刷屏。
   */
  async maybeRecordEpisode(history = [], extraTurns = []) {
    const now = Date.now();
    const last = this._lastEpisodeAt || 0;
    // 至少间隔 8 分钟，且历史至少 4 条消息
    if (now - last < 8 * 60 * 1000) return null;
    const turns = [...(history || []).slice(-12), ...extraTurns];
    if (turns.filter((t) => t?.role === 'user').length < 2) return null;
    const ep = buildEpisodeHeuristic(turns, { now });
    if (!ep) return null;
    this._lastEpisodeAt = now;
    // 缓冲供夜间合成故事链；同时落一条即时篇章
    this._episodeBuffer = [...(this._episodeBuffer || []), ep].slice(-8);
    if (typeof this.memory.recordEpisode === 'function') {
      return this.memory.recordEpisode(ep);
    }
    // 降级：记为 self 事件也能被召回
    return this.memory.recordSelfEvent(ep.content, {
      narrative: ep.title,
      importance: ep.importance,
      valence: ep.emotion > 0.5 ? 0.2 : 0.1,
      intensity: ep.emotion,
    });
  }
}

/**
 * 把 CompanionConfig 的静态人设 (外貌/说话风格/性格) 拼成一段补充, 随 persona 段注入 system prompt。
 * 外貌只注入文本描述, 不触发任何图像生成 (见 docs/companion-roadmap.md A1/A2)。
 */
function buildPersonaExtra(config) {
  if (!config) return '';
  const parts = [];
  if (config.appearance) parts.push(`外貌: ${config.appearance}`);
  if (config.speechStyle) parts.push(`说话风格: ${config.speechStyle}`);
  if (config.personality) parts.push(`性格: ${config.personality}`);
  if (Array.isArray(config.traits) && config.traits.length) parts.push(`特点: ${config.traits.join('、')}`);
  const profile = config.profile ?? {};
  const publicProfile = [];
  if (profile.legalName) publicProfile.push(`法定姓名: ${profile.legalName}`);
  if (Array.isArray(profile.nicknames) && profile.nicknames.length) publicProfile.push(`小名/昵称: ${profile.nicknames.join('、')}`);
  if (profile.gender) publicProfile.push(`性别: ${profile.gender}`);
  if (profile.birthDate) publicProfile.push(`出生日期: ${profile.birthDate}`);
  if (profile.birthPlace) publicProfile.push(`出生地: ${profile.birthPlace}`);
  if (profile.nationality) publicProfile.push(`国籍: ${profile.nationality}`);
  const family = (profile.family ?? []).filter((member) => member?.relation || member?.name).map((member) => {
    const detail = [member.name, member.nickname && `小名${member.nickname}`, member.occupation, member.location].filter(Boolean).join(' · ');
    return `${member.relation || '家人'}: ${detail || '资料待补充'}${member.notes ? `（${member.notes}）` : ''}`;
  });
  if (family.length) publicProfile.push(`家庭关系:\n${family.map((line) => `- ${line}`).join('\n')}`);
  if (publicProfile.length) parts.push(`【角色档案】\n${publicProfile.join('\n')}`);
  const menstrual = profile.menstrual ?? {};
  if (menstrual.enabled) {
    const cycle = Number(menstrual.cycleLengthDays) || 28;
    const period = Number(menstrual.periodLengthDays) || 5;
    parts.push(`【身体周期】生理期记录已开启，平均周期约 ${cycle} 天、经期约 ${period} 天。${menstrual.lastPeriodStart ? `上次周期开始日为 ${menstrual.lastPeriodStart}。` : ''}${menstrual.notes ? `备注：${menstrual.notes}` : ''} 只在相关不适或对方关心时自然表达，不主动暴露隐私。`);
  }
  return parts.join('\n');
}

/**
 * 身份硬约束: 从 CompanionConfig.identityConstraints 渲染成独立的高显著性段落,
 * 避免像 background 散文里的否定性事实那样被淹没、被模型忽略 (见 docs 里对齐这条的教训)。
 */
function buildIdentityConstraints(config) {
  if (!config?.identityConstraints?.length) return '';
  const bullets = config.identityConstraints.map((s) => `- ${s}`).join('\n');
  return [
    '【身份设定·硬约束】以下是关于对方身份的确定事实, 任何时候都不能编造/推测出与之矛盾的内容:',
    bullets,
    '用法: 只用于避免身份穿帮(如别问公司/加班/回宿舍)。不要每轮主动念这些约束, 更不要在亲密话题里突然跳到「明天上课困了别怪我」当万能结尾。',
  ].join('\n');
}

function normalizeHistory(turns = []) {
  return (turns ?? [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content != null)
    .map((t) => ({ role: t.role, content: String(t.content) }));
}

function buildProactiveInstruction(ctx = {}) {
  const reason = ctx.reason ? `触发原因: ${ctx.reason}\n` : '';
  const style = ctx.style ? `风格要求: ${ctx.style}\n` : '';
  const guide = ctx.contentPack?.styleGuide || PROACTIVE_STYLE_GUIDE;
  return `${reason}${style}${guide}\n现在不是用户刚发来消息, 而是你想主动找对方说一句话。生成一条自然、简短、有生活信息、不打扰人的主动开场；禁止空「在吗」；不要解释你在执行任务。`;
}

/** L3: 把她此刻的生活活动转成一句主动开场的由头。无活动则返回 undefined (退回默认 reason)。 */
function activityReason(life) {
  const act = life?.current_activity;
  if (!act || /睡着|睡了|生病/.test(act)) return undefined; // 睡着/生病不主动找你
  return `刚才${act}, 忽然想起你`;
}

/** 内心独白用的情境描述: 同样的"主动找对方"这件事, 但不是给生成模型的指令, 是说给"她自己"听的当下情境。 */
function buildProactiveSituation(ctx = {}) {
  const reason = ctx.reason ? ` (${ctx.reason})` : '';
  return `这一刻不是对方发消息过来, 是你自己想主动找对方说点什么${reason}。`;
}

/** 从召回 hits 里抽出 episode/篇章类记忆文本，供 prompt 注入。 */
function extractEpisodeTexts(hits = []) {
  return (hits || [])
    .filter((h) => h && (h.type === 'episode' || /【篇章】|篇章/.test(String(h.fact_core || h.content || h.narrative || ''))))
    .map((h) => h.narrative || h.content || h.fact_core)
    .filter(Boolean)
    .slice(0, 3);
}

/** 对外暴露的本轮计划摘要（debug / API） */
function summarizeTurnPlan(turn) {
  if (!turn) return null;
  return {
    historyTurns: turn.historyTurns,
    useMonologue: turn.useMonologue,
    recallQuery: turn.recallQuery,
    partsBudget: turn.partsBudget,
    replyFormat: turn.replyFormat ?? null,
    turnBrief: turn.turnBrief ?? null,
  };
}

/** 对外暴露的结构化决策摘要 */
function summarizeStructured(structured) {
  if (!structured) return null;
  return {
    attitude: structured.attitude,
    lengthHint: structured.lengthHint,
    mentionStory: structured.mentionStory,
    mentionUnfinished: structured.mentionUnfinished,
    wantPhoto: structured.wantPhoto,
    bubbleCount: structured.bubbleCount,
    replyFormat: structured.replyFormat,
    actions: structured.actions || [],
    note: structured.note || '',
    source: structured.source,
  };
}

/** 对外暴露的本场会话线摘要 */
function summarizeSessionThread(thread) {
  if (!thread || !thread.turnCount) return null;
  return {
    turnCount: thread.turnCount,
    primaryTopic: thread.primaryTopic,
    topics: thread.topics || [],
    emotionalTone: thread.emotionalTone,
    openQuestions: (thread.openQuestions || []).map((q) => q.text),
    openCommitments: (thread.commitments || [])
      .filter((c) => c.status === 'open')
      .map((c) => ({ who: c.who, text: c.text })),
  };
}
