// Emotion · 短时情绪展示层 (valence/energy/warmth)。
//
// 心情(valence/arousal)的来源、衰减、更新统一由 M1 (src/state/affect.js) 的
// affective_state 维护 —— recall 心情门控(M2)/重构(M3)依赖的也是这一份状态,
// 不再单独起一套"情绪"状态机各算各的增量 (避免两套状态各打一次 LLM、互不通气)。
// 本文件只做【M1 状态 -> {valence, energy, warmth}】的纯映射 + toPrompt/samplingHints。

import { clampState, defaultState } from './state/affect.js';
import { PARAMS } from './config.js';

const FIELD_RANGE = {
  valence: [-1, 1],
  energy: [0, 1],
  warmth: [0, 1],
};

/** 裁剪到合法范围, 缺字段补中值。 */
export function clampEmotion(state = {}) {
  return {
    valence: clampField('valence', state.valence),
    energy: clampField('energy', state.energy),
    warmth: clampField('warmth', state.warmth),
  };
}

/** 新用户 (无 affective_state 记录) 时的默认短时情绪。 */
export function defaultEmotion() {
  return moodToEmotion(defaultState());
}

/**
 * M1 状态 -> 短时情绪。
 * - valence/energy 直接对应 mood.valence/arousal (范围一致, 衰减/更新已由 M1 完成)。
 * - warmth = 亲密度基线(relationship.closeness) + 当下心情/紧张的短时调整
 *   —— 处得越熟平时基准越高, 但吵架/还欠着没和好的这一刻会"变冷", 即使关系阶段没变。
 */
export function moodToEmotion(state) {
  const s = clampState(state);
  const { warmthValenceWeight, warmthTensionWeight, warmthRepairDebtWeight } = PARAMS.emotion;
  const warmth =
    s.relationship.closeness +
    s.mood.valence * warmthValenceWeight -
    s.relationship.tension * warmthTensionWeight -
    s.relationship.repair_debt * warmthRepairDebtWeight;
  return clampEmotion({ valence: s.mood.valence, energy: s.mood.arousal, warmth });
}

/** 把短时情绪翻译成"表现指引", 注入 system; 别让她直接报数值。 */
export function toEmotionPrompt(state) {
  if (!state) return '';
  const s = clampEmotion(state);
  const mood = s.valence > 0.4 ? '心情不错' : s.valence < -0.2 ? '有点低落' : '比较平静';
  const energy = s.energy > 0.7 ? '很有兴致' : s.energy < 0.3 ? '有些没精神' : '状态一般';
  const warmth = s.warmth < 0.35 ? '对对方会稍微收着一点' : s.warmth > 0.72 ? '语气可以更柔软亲近' : '';
  const parts = [`你现在${mood}, ${energy}`];
  if (warmth) parts.push(warmth);
  return `${parts.join(', ')}。让它自然影响语气和话量, 别明说自己的情绪状态。`;
}

/** 情绪 -> 采样参数。低 energy 时短、平、温度低; 高 energy 时长、活、温度高。 */
export function emotionSamplingHints(state) {
  const s = clampEmotion(state);
  const temperature = round(clamp(0.7 + s.energy * 0.4, 0.6, 1.15), 2);
  return {
    temperature,
    maxTokens: s.energy < 0.3 ? 220 : s.energy > 0.75 ? 650 : 500,
  };
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
