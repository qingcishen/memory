// 编排器 · 子系统适配层。
//
// 把 cyber-memory 现有的 Memory / persona / state 门面包成编排器要的统一接口
// (memory / stateLayer / relationship / persona, 见 companion-roadmap §3)。
// 编排器只认这里的方法签名, 不直接 import 下面这些底层模块。

import { Memory } from '../memory.js';
import { personaBlock } from '../persona.js';
import { readState, clampState } from '../state/affect.js';
import { StateLayer } from '../state/stateLayer.js';

// ============================================================
//  纯逻辑: state -> 自然语言 (供 toPrompt 使用, 可离线单测)
// ============================================================

/** 把关系状态翻译成影响称呼/边界/主动度的一句话; 空状态返回空串。 */
export function formatRelationshipPrompt(state) {
  if (!state) return '';
  const { closeness, trust, repair_debt } = clampState(state).relationship;
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
  constructor({ userId, subjectName = '对方' }) {
    this._mem = new Memory({ userId, subjectName });
  }

  /** 输入当前用户消息, 返回可直接注入 system prompt 的记忆块。 */
  async recall(query, opts = {}) {
    return this._mem.recallAsPrompt(query, opts);
  }

  /**
   * 提取记忆 + 更新状态层底座(M1) 都在这一步完成, 见 StateLayerAdapter/RelationshipAdapter 的注释。
   * useLLM: true —— 让 M1 的状态机用 LLM 增量(而不仅是启发式), 这一次推断同时产出
   * mood(情绪/life 精力) 和 relationship(关系) 的增量, 状态层/关系适配器都读这一份结果。
   */
  async observe(turns, opts = {}) {
    await this._mem.observe(turns, { useLLM: true, ...opts });
  }
}

/** 状态层门面适配: 包统一 StateLayer, 编排器不再直接接 emotion。 */
export class StateLayerAdapter {
  constructor(userId) {
    this.stateLayer = new StateLayer({ userId });
  }

  async snapshot() {
    return this.stateLayer.snapshot();
  }

  /** 状态增量已经在 memory.observe({ useLLM: true }) 里随 M1 状态机完成, 这里不重复写。 */
  async evolve() {}

  toPrompt(snapshot) {
    return this.stateLayer.toPrompt(snapshot);
  }

  samplingHints(snapshot) {
    return this.stateLayer.samplingHints(snapshot);
  }
}

/** 关系门面适配: 读 cyber-memory 的 affective_state.relationship。 */
export class RelationshipAdapter {
  constructor(userId) {
    this.userId = userId;
  }

  async current() {
    return readState(this.userId);
  }

  /** 原因同 StateLayerAdapter.evolve: relationship 的增量已随 memory.observe({ useLLM: true }) 完成, 这里不重复写。 */
  async bump() {}

  toPrompt(state) {
    return formatRelationshipPrompt(state);
  }
}

/** 人格门面适配: 包 persona.js 的 self 记忆。personaBlock 需要 IO, 缓存后 toPrompt 同步取用。 */
export class PersonaAdapter {
  constructor({ userId, subjectName = '她' }) {
    this.userId = userId;
    this.subjectName = subjectName;
    this._cached = '';
  }

  get name() {
    return this.subjectName;
  }

  /** 加载并缓存人格段; 编排器在 init() 里调一次, 之后 toPrompt() 同步返回缓存。 */
  async load(opts = {}) {
    this._cached = await personaBlock(this.userId, this.subjectName, opts).catch(() => '');
    return this._cached;
  }

  toPrompt() {
    return this._cached;
  }
}
