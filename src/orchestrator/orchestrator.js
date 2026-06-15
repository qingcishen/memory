// 编排器主体。
//
// reply() = 同步路径: 并行加载状态/记忆 -> (可选)内心独白 -> 组装 prompt -> 生成回复。
// proactiveTick() = 后台主动性入口: 定时器/事件触发 -> 复用同一套 prompt 组装生成主动开场。
// afterReply() = 后台路径: stateLayer.evolve / memory.observe / relationship.bump, allSettled, 不阻塞回复。
// 详见编排器设计方案 §5。

import { MemoryAdapter, StateLayerAdapter, RelationshipAdapter, PersonaAdapter } from './adapters.js';
import { DefaultLLM } from './llm.js';
import { assemble, buildMonologueContext, buildTimePrompt } from './assemble.js';
import { hoursSince } from '../decay.js';
import { getCompanion } from '../companion.js';
import { Selfie, decidePhoto } from '../appearance/index.js';
import { PARAMS } from '../params.js';

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

    // 先建状态层, 再把它内部的 LifeDimension 注入记忆适配器 —— 让 memory.observe 与状态层
    // 共用同一个 life 实例 (L4: 生病/被照顾由 memory.observe 统一演变, 避免双写 life_state)。
    this.stateLayer = deps.stateLayer ?? new StateLayerAdapter(userId, companionId, null, { activityFn, lifeConfig });
    const sharedLife = this.stateLayer?.stateLayer?.life ?? null;
    this.memory = deps.memory ?? new MemoryAdapter({ userId, companionId, subjectName, companionName, life: sharedLife });
    this.relationship = deps.relationship ?? new RelationshipAdapter(userId, companionId);
    this.persona = deps.persona ?? new PersonaAdapter({ userId, companionId, subjectName: companionName });
    this.llm = deps.llm ?? new DefaultLLM();
    this.historyStore = deps.historyStore ?? null;

    // A1 拍照分享 (自拍 + 随手拍): 需要 onPhoto 投递回调才会启用 —— 没有投递渠道就不生成,
    // 这也让全 mock 的编排器测试默认离线 (不注入 onPhoto 即跳过)。photo 能力默认用真实 Selfie。
    this.photo = deps.photo ?? new Selfie({ userId, companionId, provider: deps.imageProvider });
    this.onPhoto = deps.onPhoto ?? null;
    // 天气感知 (可选): 注入了才拉真实天气并进 prompt; 默认 null → 离线安全 (mock 测试不连网)。
    this.weather = deps.weather ?? null;

    this.history = [];
    this._personaLoadedAt = 0;
    this._historyLoaded = false;
    this._configLoaded = false;
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
      }
      this._configLoaded = true;
    }
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
    const loaded = await this.historyStore.load({ userId: this.userId, companionId: this.companionId, limit });
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
      this._lastHistoryPersist = Promise.resolve(this.historyStore.append({ userId: this.userId, companionId: this.companionId, turns: clean })).catch((reason) => {
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

    const [stateSnapshot, relState, memoryBlock, weather, lastUserMessageAt] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
      this.memory.recall(userMessage).catch(() => ''),
      this.weather ? this.weather.current().catch(() => '') : Promise.resolve(''),
      // 时间跳跃感: 取"对方上次说话"的时间(早于本轮, 因为本轮还没 recordHistory) -> 距今多久。
      this.historyStore && typeof this.historyStore.lastUserMessageAt === 'function'
        ? this.historyStore.lastUserMessageAt({ userId: this.userId, companionId: this.companionId }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const gapHours = lastUserMessageAt != null ? hoursSince(lastUserMessageAt) : null;

    const promptParts = {
      timePrompt: buildTimePrompt(new Date(), { weather, gapHours }),
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

    // A1: 用户要看她样子时, 后台生成一张自拍 (fire-and-forget, 经 onPhoto 投递, 不阻塞文字)。
    if (PHOTO_REQUEST_RE.test(userMessage)) this._lastPhoto = this.maybePhoto(stateSnapshot, { requested: true });

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
    const [stateSnapshot, relState, memoryBlock, weather] = await Promise.all([
      this.stateLayer.snapshot().catch(() => null),
      this.relationship.current().catch(() => null),
      this.memory.recall(seed).catch(() => ''),
      this.weather ? this.weather.current().catch(() => '') : Promise.resolve(''),
    ]);

    const promptParts = {
      timePrompt: buildTimePrompt(new Date(), { weather }),
      personaPrompt: this.persona.toPrompt() ?? '',
      relationshipPrompt: this.relationship.toPrompt(relState) ?? '',
      statePrompt: this.stateLayer.toPrompt(stateSnapshot) ?? '',
      memoryBlock: memoryBlock ?? '',
    };

    // L3: 没显式给触发原因时, 用她此刻的生活活动作主动开场的由头 (忙完想起你 / 做某事分享)。
    const effCtx = { ...ctx, reason: ctx.reason ?? activityReason(stateSnapshot?.life) };

    let monologue = '';
    if (ctx.useMonologue ?? this.options.useMonologue) {
      const situation = buildProactiveSituation(effCtx);
      monologue = await this.llm.think(buildMonologueContext({ situation, ...promptParts })).catch(() => '');
    }

    const messages = assemble({
      userMessage: buildProactiveInstruction(effCtx),
      history: this.history,
      historyTurns: this.options.historyTurns,
      ...promptParts,
      monologue,
    });

    const samplingHints =
      typeof this.stateLayer.samplingHints === 'function' && stateSnapshot ? this.stateLayer.samplingHints(stateSnapshot) : {};
    const proactive = await this.llm.generateReply(messages, samplingHints);

    if (ctx.recordHistory !== false) this.recordHistory([{ role: 'assistant', content: proactive }]);

    // A1: 主动找你时也可能顺手分享一张照片 (在外面看到风景/猫狗的随手拍, 或心情好的自拍)。
    this._lastPhoto = this.maybePhoto(stateSnapshot, {});

    return proactive;
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
   * - nightly: 额外 reflect(归纳印象) + story(我们的故事) + dedupe(合并近义重复)。
   * 任一失败只记日志, 互不影响。
   */
  async maintain({ now = Date.now(), nightly = false } = {}) {
    const tasks = [];
    if (typeof this.memory.settle === 'function') tasks.push(this.memory.settle(now));
    if (typeof this.stateLayer.tickActivity === 'function') tasks.push(this.stateLayer.tickActivity());
    if (nightly) {
      if (typeof this.memory.reflect === 'function') tasks.push(this.memory.reflect());
      if (typeof this.memory.story === 'function') tasks.push(this.memory.story());
      if (typeof this.memory.dedupe === 'function') tasks.push(this.memory.dedupe());
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') console.error('[maintain]', r.reason);
    return results;
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
  return parts.join('\n');
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
