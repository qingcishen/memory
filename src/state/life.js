// Life · 生命/身体状态维度。
//
// L1 先只承接原 emotion.energy: energy = M1 affective_state.mood.arousal。
// 后续 L2~L4 可在这个维度里继续扩展 satiety/health/作息/活动, 编排器侧不需要再改。

import { readState, decayState } from './affect.js';

const HOUR = 1000 * 60 * 60;
const FIELD_RANGE = {
  energy: [0, 1],
};

/** 裁剪到合法范围, 缺字段补中值。 */
export function clampLife(state = {}) {
  return {
    energy: clampField('energy', state.energy),
  };
}

/** M1 状态 -> life 维度。L1 只把 mood.arousal 迁到这里。 */
export function moodToLife(state = {}) {
  return clampLife({ energy: state?.mood?.arousal });
}

/** 把精力状态翻译成表现指引, 注入 system; 别让她直接报数值。 */
export function toLifePrompt(state) {
  if (!state) return '';
  const s = clampLife(state);
  const energy = s.energy > 0.7 ? '很有兴致' : s.energy < 0.3 ? '有些没精神' : '状态一般';
  return `你现在${energy}。让它自然影响语气和话量, 别明说自己的身体状态。`;
}

/** life.energy -> 采样参数。低 energy 时短、平、温度低; 高 energy 时长、活、温度高。 */
export function lifeSamplingHints(state) {
  const s = clampLife(state);
  const temperature = round(clamp(0.7 + s.energy * 0.4, 0.6, 1.15), 2);
  return {
    temperature,
    maxTokens: s.energy < 0.3 ? 220 : s.energy > 0.75 ? 650 : 500,
  };
}

/** 状态层内部维度门面。 */
export class LifeDimension {
  constructor({ userId, read = readState, now = () => Date.now() } = {}) {
    this.userId = userId;
    this.read = read;
    this.now = now;
  }

  async current() {
    const state = this.userId ? await this.read(this.userId) : {};
    const hours = state.updated_at ? Math.max(0, (this.now() - new Date(state.updated_at).getTime()) / HOUR) : 0;
    return moodToLife(decayState(state, hours));
  }

  async evolve() {}

  toPrompt(state) {
    return toLifePrompt(state);
  }

  samplingHints(state) {
    return lifeSamplingHints(state);
  }
}

// ---- helpers (纯) ----
function clampField(field, value) {
  const [lo, hi] = FIELD_RANGE[field];
  return clamp(num(value, (lo + hi) / 2), lo, hi);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function round(value, digits) {
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}
