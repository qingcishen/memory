// 编排器 · 子系统适配层。
//
// 把 cyber-memory 现有的 Memory / persona / state 门面包成编排器要的统一接口
// (memory / stateLayer / relationship / persona, 见 companion-roadmap §3)。
// 编排器只认这里的方法签名, 不直接 import 下面这些底层模块。

import { Memory } from '../memory.js';
import { personaBlock } from '../persona.js';
import { readState, clampState, seedInitialStateIfNew } from '../state/affect.js';
import { StateLayer } from '../state/stateLayer.js';

// ============================================================
//  纯逻辑: state -> 自然语言 (供 toPrompt 使用, 可离线单测)
// ============================================================

/** 把关系状态翻译成影响称呼/边界/主动度的一句话; 空状态返回空串。 */
export function formatRelationshipPrompt(state) {
  if (!state) return '';
  const { closeness, trust, repair_debt, tension, tension_target, tension_topic } = clampState(state).relationship;
  // #5 情绪指向性: 她正紧张时, 先区分这股情绪冲着谁 —— 冲着外部别迁怒于你, 冲着你则先别急着讲道理。
  if (tension > 0.4) {
    if (tension_target === 'external') {
      const reason = tension_topic ? `因为${tension_topic}` : '因为外面的一些事';
      return `她最近${reason}有点烦躁、心不在焉, 但不是冲你来的 —— 多体谅她, 主动关心一句会很受用, 别往自己身上揽。`;
    }
    return '她现在对你有点情绪, 语气会收着些, 先顺着她、别急着讲道理或辩解。';
  }
  if (repair_debt > 0.3) return '你们之间还有点没和好的别扭, 她还在等一句主动的道歉。';
  if (closeness > 0.75) return '你们已经很亲密了, 称呼和语气可以更黏人、更随意。';
  if (closeness > 0.5) {
    return trust > 0.5 ? '你们处得不错, 算是熟悉信任的关系。' : '你们处得还行, 但她对你还留着一点保留。';
  }
  return '你们还不算太熟, 说话要保持一点礼貌和分寸。';
}

// ============================================================
//  适配类 (IO 包装)
// ============================================================

/** 记忆门面适配: 包 cyber-memory 的 Memory 类。 */
export class MemoryAdapter {
  // life: 与 StateLayerAdapter 共享的同一个 LifeDimension。observe 时由 Memory 统一演变 life
  // 并把"生病/被照顾"对情绪/关系的耦合增量并进 affect 写入 (L4, 避免双写 life_state)。
  constructor({ userId, companionId = 'default', subjectName = '对方', companionName = '她', life = null }) {
    this._mem = new Memory({ userId, companionId, subjectName, companionName });
    this._life = life;
  }

  /** 输入当前用户消息, 返回可直接注入 system prompt 的记忆块。 */
  async recall(query, opts = {}) {
    return this._mem.recallAsPrompt(query, opts);
  }

  /**
   * 提取记忆 + 更新状态层底座(M1) + 演变 life(L4 生病/被照顾) 都在这一步完成。
   * useLLM: true —— 让 M1 的状态机用 LLM 增量; life 注入后, 身心耦合增量在这次 affect 写入里一起落库。
   */
  async observe(turns, opts = {}) {
    await this._mem.observe(turns, { useLLM: true, life: this._life, ...opts });
  }

  // ---- 维护期委托 (给后台调度循环用; 没对话时也让她的内在演变/沉淀) ----
  settle(now) {
    return this._mem.settle(now);
  }
  reflect(opts) {
    return this._mem.reflect(opts);
  }
  story(opts) {
    return this._mem.story(opts);
  }
  dedupe(opts) {
    return this._mem.dedupe(opts);
  }
  /** M9 每日训练: 知识滴灌 + 自我日记, 见 src/training.js。 */
  train(opts) {
    return this._mem.train(opts);
  }
  checkProspective(ctx, now) {
    return this._mem.checkProspective(ctx, now);
  }
  dismissProspective(ids) {
    return this._mem.dismissProspective(ids);
  }
}

/** 状态层门面适配: 包统一 StateLayer, 编排器不再直接接 emotion。 */
export class StateLayerAdapter {
  constructor(userId, companionId = 'default', stateLayer = null, { activityFn, lifeConfig } = {}) {
    // 角色专属作息 activityFn / 身体参数 lifeConfig 经此注入到内部 StateLayer→LifeDimension (没传则用通用默认)。
    this.stateLayer = stateLayer ?? new StateLayer({ userId, companionId, activityFn, lifeConfig });
  }

  async snapshot() {
    return this.stateLayer.snapshot();
  }

  /**
   * no-op: 情绪/关系增量随 memory.observe 的 M1 状态机完成; life(精力/生病/被照顾)也已移交
   * memory.observe 统一演变 (MemoryAdapter 注入了同一个 LifeDimension), 这里再演变就会重复写 life_state。
   */
  async evolve() {}

  /** L3/L4: 无对话时也推进她的一天 (作息活动派生 + 自动生病判定), 固化进库。 */
  async tickActivity() {
    if (typeof this.stateLayer.life?.tickActivity === 'function') return this.stateLayer.life.tickActivity();
  }

  toPrompt(snapshot) {
    return this.stateLayer.toPrompt(snapshot);
  }

  samplingHints(snapshot) {
    return this.stateLayer.samplingHints(snapshot);
  }
}

/** 关系门面适配: 读 cyber-memory 的 affective_state.relationship。 */
export class RelationshipAdapter {
  constructor(userId, companionId = 'default') {
    this.userId = userId;
    this.companionId = companionId;
  }

  async current() {
    return readState(this.userId, this.companionId);
  }

  /** 原因同 StateLayerAdapter.evolve: relationship 的增量已随 memory.observe({ useLLM: true }) 完成, 这里不重复写。 */
  async bump() {}

  /**
   * 只在这个 (user, companion) 还没有任何记录时, 用人设的关系起点/情绪基线落一条初始状态
   * (见 src/state/affect.js seedInitialStateIfNew)。Orchestrator.init() 在配置刚加载出来时调一次。
   */
  async seedIfNew(config) {
    return seedInitialStateIfNew(this.userId, this.companionId, config).catch((e) => {
      console.error('[seedIfNew]', e);
      return null;
    });
  }

  toPrompt(state) {
    return formatRelationshipPrompt(state);
  }
}

/** 人格门面适配: 包 persona.js 的 self 记忆。personaBlock 需要 IO, 缓存后 toPrompt 同步取用。 */
export class PersonaAdapter {
  constructor({ userId, companionId = 'default', subjectName = '她' }) {
    this.userId = userId;
    this.companionId = companionId;
    this.subjectName = subjectName;
    this._cached = '';
    this._extra = ''; // CompanionConfig 的外貌/说话风格/性格补充 (见 Orchestrator.init)
  }

  get name() {
    return this.subjectName;
  }

  /** 加载并缓存人格段; 编排器在 init() 里调一次, 之后 toPrompt() 同步返回缓存。 */
  async load(opts = {}) {
    this._cached = await personaBlock(this.userId, this.companionId, this.subjectName, opts).catch(() => '');
    return this._cached;
  }

  /** 设置来自 CompanionConfig 的静态人设补充 (外貌/说话风格/性格), 随 self 记忆一起注入。 */
  setExtra(text) {
    this._extra = text || '';
  }

  toPrompt() {
    return [this._cached, this._extra].filter((s) => s && s.trim()).join('\n');
  }
}
