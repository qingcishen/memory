/**
 * M3 · 行为模式库
 *
 * 行为模式是参数，不是要模型背诵的人设散文。这里仅负责默认值、规范化和
 * 情境解析；如何把参数转成生成指导由 personalityCompiler 负责。
 */

export const SITUATION_TYPES = Object.freeze([
  'when_user_sad',
  'when_user_distant',
  'when_conflict',
  'when_user_excited',
]);

export const RESPONSE_LENGTHS = Object.freeze([
  'very_short',
  'short',
  'short_to_medium',
  'medium',
  'medium_to_long',
]);

export const DEFAULT_BEHAVIOR_PROFILE = Object.freeze({
  response_length: 'medium',
});

export const DEFAULT_BEHAVIORAL_PATTERNS = deepFreeze({
  when_user_sad: {
    acknowledge_before_fix: true,
    physical_comfort_language: 0.8,
    advice_probability: 0.15,
    silence_tolerance: 0.9,
    response_length: 'short_to_medium',
  },
  when_user_distant: {
    pursue_directly: false,
    use_small_talk_as_bridge: true,
    internal_anxiety: 0.7,
    wait_before_asking: true,
  },
  when_conflict: {
    first_response_softens: true,
    initiates_apology_first: false,
    needs_cooling_period: true,
    returns_when_ready: true,
  },
  when_user_excited: {
    match_energy: true,
    ask_followup: 0.85,
    share_similar_memory: 0.6,
  },
});

const SITUATION_ALIASES = Object.freeze({
  sad: 'when_user_sad',
  user_sad: 'when_user_sad',
  sadness: 'when_user_sad',
  distressed: 'when_user_sad',
  distant: 'when_user_distant',
  user_distant: 'when_user_distant',
  withdrawn: 'when_user_distant',
  conflict: 'when_conflict',
  argument: 'when_conflict',
  tense: 'when_conflict',
  repair: 'when_conflict',
  excited: 'when_user_excited',
  user_excited: 'when_user_excited',
  happy: 'when_user_excited',
});

const BOOLEAN_FIELDS = new Set([
  'acknowledge_before_fix',
  'pursue_directly',
  'use_small_talk_as_bridge',
  'wait_before_asking',
  'first_response_softens',
  'initiates_apology_first',
  'needs_cooling_period',
  'returns_when_ready',
  'match_energy',
]);

const UNIT_FIELDS = new Set([
  'physical_comfort_language',
  'advice_probability',
  'silence_tolerance',
  'internal_anxiety',
  'ask_followup',
  'share_similar_memory',
]);

/**
 * 把外部情境名收敛到模式库键。自定义键不会被丢弃。
 */
export function normalizeSituationType(situation = '') {
  const key = String(situation || '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return SITUATION_ALIASES[key] || key || 'default';
}

/**
 * 规范化单个行为包。只对已知字段做类型收敛，自定义字段原样保留，便于扩展。
 */
export function normalizeBehaviorProfile(profile = {}, fallback = {}) {
  const source = isPlainObject(profile) ? profile : {};
  const base = isPlainObject(fallback) ? fallback : {};
  const output = { ...base, ...source };

  for (const key of BOOLEAN_FIELDS) {
    if (!(key in output)) continue;
    output[key] = normalizeBoolean(output[key], base[key] ?? false);
  }
  for (const key of UNIT_FIELDS) {
    if (!(key in output)) continue;
    output[key] = clamp01(output[key], base[key] ?? 0);
  }
  if ('response_length' in output) {
    output.response_length = RESPONSE_LENGTHS.includes(output.response_length)
      ? output.response_length
      : (RESPONSE_LENGTHS.includes(base.response_length) ? base.response_length : DEFAULT_BEHAVIOR_PROFILE.response_length);
  }

  return output;
}

/**
 * 深合并默认模式。调用方给出的局部覆盖不会让其余默认情境消失。
 */
export function normalizeBehavioralPatterns(patterns = {}) {
  const source = isPlainObject(patterns) ? patterns : {};
  const keys = new Set([...Object.keys(DEFAULT_BEHAVIORAL_PATTERNS), ...Object.keys(source)]);
  const output = {};

  for (const rawKey of keys) {
    const key = normalizeSituationType(rawKey);
    const fallback = DEFAULT_BEHAVIORAL_PATTERNS[key] || {};
    const provided = source[rawKey] ?? source[key] ?? {};
    output[key] = normalizeBehaviorProfile(provided, fallback);
  }

  return output;
}

/**
 * 从完整模式库中解析当前情境。未知情境返回中性行为包而不是任取一个场景。
 */
export function resolveBehaviorPattern(patterns = {}, situation = 'default') {
  const normalized = normalizeBehavioralPatterns(patterns);
  const key = normalizeSituationType(situation);
  return {
    situation: key,
    profile: normalized[key]
      ? { ...normalized[key] }
      : { ...DEFAULT_BEHAVIOR_PROFILE },
    matched: Boolean(normalized[key]),
  };
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(fallback);
}

function clamp01(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
