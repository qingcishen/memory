// 编排器主体。
//
// reply() = 同步路径: 并行加载状态/记忆 -> (可选)内心独白 -> 组装 prompt -> 生成回复。
// proactiveTick() = 后台主动性入口: 定时器/事件触发 -> 复用同一套 prompt 组装生成主动开场。
// afterReply() = 后台路径: stateLayer.evolve / memory.observe / relationship.bump, allSettled, 不阻塞回复。
// 详见编排器设计方案 §5。

import { MemoryAdapter, StateLayerAdapter, RelationshipAdapter, PersonaAdapter } from './adapters.js';
import { DefaultLLM } from './llm.js';
import { assemble, buildMonologueContext } from './assemble.js';
import { PARAMS } from '../params.js';

const DEFAULT_HISTORY_TURNS = 6;

export class Orchestrator {
  /**
   * @param deps 可注入 { memory, stateLayer, relationship, persona, llm, historyStore }, 默认用真实适配器。
   * @param options { useMonologue=true, historyTurns=6 }
   */
  constructor({ userId, subjectName = '对方', companionName = '她', deps = {}, options = {} }) {
    if (!userId) throw new Error('Orchestrator 需要 userId');
    this.userId = userId;
    this.subjectName = subjectName;
    this.companionName = companionName;
    this.options = {
      useMonologue: true,
      historyTurns: DEFAULT_HISTORY_TURNS,
      personaRefreshMs: PARAMS.orchestrator.personaRefreshMs,
      ...options,
    };

    this.memory = deps.memory ?? new MemoryAdapter({ userId, subjectName });
    this.stateLayer = deps.stateLayer ?? new StateLayerAdapter(userId);
    this.relationship = deps.relationship ?? new RelationshipAdapter(userId);
    this.persona = deps.persona ?? new PersonaAdapter({ userId, subjectName: companionName });
    this.llm = deps.llm ?? new DefaultLLM();
    this.historyStore = deps.historyStore ?? null;

    this.history = [];
    this._personaLoadedAt = 0;
    this._historyLoaded = false;
  }

  /**
   * 加载/刷新人格段 (IO); reply() 会自动调用。
   * 首次总会加载; 之后每隔 personaRefreshMs 重新加载一次, 让长期运行的实例
   * (如 ProactiveScheduler 反复复用同一个 Orchestrator) 能感知到 self 记忆的更新。
   */
  async init() {
    const now = Date.now();
    if (!this._personaLoadedAt || now - this._personaLoadedAt >= this.options.personaRefreshMs) {
      if (typeof this.persona.load === 'function') await this.persona.load().catch(() => {});
      this._personaLoadedAt = now;
    }
    if (!this._historyLoaded) {
      await this.loadHistory().catch(() => {});
      this._historyLoaded = true;
    }
    return this;
  }

  /** 从可选 historyStore 拉最近短期历史; 默认内存版什么也不做。 */
  async loadHistory() {
    if (!this.historyStore || typeof this.historyStore.load !== 'function') return this.history;
    const limit = this.options.historyTurns * 2;
    const loaded = await this.historyStore.load({ userId: this.userId, limit });
    if (Array.isArray(loaded)) {
      this.history = normalizeHistory(loaded).slice(-limit);
      this.trimHistory();
    }
    return this.history;
  }

  /** 只保留最近 historyTurns 轮(user+assistant 各一条)。 */
  trimHistory() {
    const max = this.options.historyTurns * 2;
    if (this.history.length > max) this.history = this.history.slice(-max);
  }

  /** 写入实例内短期历史, 并把增量异步交给可选 historyStore。 */
  recordHistory(turns = []) {
    const clean = normalizeHistory(turns);
    if (clean.length === 0) return;
    this.history.push(...clean);
    this.trimHistory();
    if (this.historyStore && typeof this.historyStore.append === 'function') {
      this._lastHistoryPersist = Promise.resolve(this.historyStore.append({ userId: this.userId, turns: clean })).catch((reason) => {
        console.error('[historyStore]', reason);
      });
    }
  }

  /**
   * 一轮对话主入口: 加载状态+记忆 -> (可选)内心独白 -> 组装 -> 生成回复。
   * 任一子系统加载失败都降级为空, 不影响回复 (见编排器设计方案 §9)。
   */
  async reply(userMessage) {
    await this.init();

    const [stateSnapshot, relState, memoryBlock] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
      this.memory.recall(userMessage).catch(() => ''),
    ]);

    const promptParts = {
      personaPrompt: this.persona.toPrompt() ?? '',
      relationshipPrompt: this.relationship.toPrompt(relState) ?? '',
      statePrompt: this.stateLayer.toPrompt(stateSnapshot) ?? '',
      memoryBlock: memoryBlock ?? '',
    };

    let monologue = '';
    if (this.options.useMonologue) {
      const ctx = buildMonologueContext({ userMessage, ...promptParts });
      monologue = await this.llm.think(ctx).catch(() => '');
    }

    const messages = assemble({
      userMessage,
      history: this.history,
      historyTurns: this.options.historyTurns,
      ...promptParts,
      monologue,
    });

    const samplingHints =
      typeof this.stateLayer.samplingHints === 'function' && stateSnapshot ? this.stateLayer.samplingHints(stateSnapshot) : {};
    const reply = await this.llm.generateReply(messages, samplingHints);

    this.recordHistory([
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply },
    ]);

    // fire-and-forget; 暴露在 _lastAfterReply 上仅供测试 await。
    this._lastAfterReply = this.afterReply(userMessage, reply);

    return reply;
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

    const seed = ctx.query ?? ctx.memoryQuery ?? ctx.reason ?? '想主动找对方聊一句';
    const [stateSnapshot, relState, memoryBlock] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
      this.memory.recall(seed).catch(() => ''),
    ]);

    const promptParts = {
      personaPrompt: this.persona.toPrompt() ?? '',
      relationshipPrompt: this.relationship.toPrompt(relState) ?? '',
      statePrompt: this.stateLayer.toPrompt(stateSnapshot) ?? '',
      memoryBlock: memoryBlock ?? '',
    };

    let monologue = '';
    if (ctx.useMonologue ?? this.options.useMonologue) {
      const situation = buildProactiveSituation(ctx);
      monologue = await this.llm.think(buildMonologueContext({ situation, ...promptParts })).catch(() => '');
    }

    const messages = assemble({
      userMessage: buildProactiveInstruction(ctx),
      history: this.history,
      historyTurns: this.options.historyTurns,
      ...promptParts,
      monologue,
    });

    const samplingHints =
      typeof this.stateLayer.samplingHints === 'function' && stateSnapshot ? this.stateLayer.samplingHints(stateSnapshot) : {};
    const proactive = await this.llm.generateReply(messages, samplingHints);

    if (ctx.recordHistory !== false) this.recordHistory([{ role: 'assistant', content: proactive }]);
    return proactive;
  }

  /** 回复返回后触发的后台状态更新, 任一失败只记日志, 不影响已发出的回复。 */
  afterReply(userMessage, reply) {
    const turns = [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply },
    ];
    return Promise.allSettled([
      this.stateLayer.evolve(turns),
      this.memory.observe(turns),
      this.relationship.bump(),
    ]).then((results) => {
      for (const r of results) if (r.status === 'rejected') console.error('[afterReply]', r.reason);
      return results;
    });
  }
}

function normalizeHistory(turns = []) {
  return (turns ?? [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content != null)
    .map((t) => ({ role: t.role, content: String(t.content) }));
}

function buildProactiveInstruction(ctx = {}) {
  const reason = ctx.reason ? `触发原因: ${ctx.reason}\n` : '';
  const style = ctx.style ? `风格要求: ${ctx.style}\n` : '';
  return `${reason}${style}现在不是用户刚发来消息, 而是你想主动找对方说一句话。生成一条自然、简短、不打扰人的主动开场, 不要解释你在执行任务。`;
}

/** 内心独白用的情境描述: 同样的"主动找对方"这件事, 但不是给生成模型的指令, 是说给"她自己"听的当下情境。 */
function buildProactiveSituation(ctx = {}) {
  const reason = ctx.reason ? ` (${ctx.reason})` : '';
  return `这一刻不是对方发消息过来, 是你自己想主动找对方说点什么${reason}。`;
}
