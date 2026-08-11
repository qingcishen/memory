/**
 * M3 · 人格自然漂移
 *
 * 重大事件只创建一个有起止时间的漂移计划；实际值按时间插值，避免一次事件
 * 让人格瞬间翻转。IO 通过 applyDrift 的第三个参数注入。
 */

import { normalizePersonalitySystem } from './personalityCompiler.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DRIFT_DAYS = 7;

export const PERSONALITY_DRIFT_RULES = deepFreeze({
  trust_broken: {
    duration_days: 7,
    changes: {
      'core_values.security_need': 0.05,
    },
  },
  deep_understanding_received: {
    duration_days: 7,
    changes: {
      'core_values.authenticity': 0.03,
    },
  },
  long_separation: {
    duration_days: 10,
    changes: {
      'emotional_signature.sensitivity_map.separation.intensity': 0.05,
      'state_modifiers.longing_growth_multiplier': 0.08,
    },
  },
});

/**
 * 把事件转换为有上限的有符号变化量。
 */
export function derivePersonalityDelta(personality = {}, event = {}, options = {}) {
  const type = String(event?.type || '').trim();
  if (!type) throw new TypeError('event.type is required');
  const rule = PERSONALITY_DRIFT_RULES[type] || { changes: {} };
  const strength = clamp01(event.intensity ?? event.magnitude, 1);
  const maxStep = clampPositive(options.maxStep, 0.1);
  const customChanges = normalizeCustomDelta(event.delta);
  const rawChanges = Object.keys(customChanges).length ? customChanges : rule.changes;
  const changes = {};

  for (const [path, rawDelta] of Object.entries(rawChanges || {})) {
    const delta = Number(rawDelta);
    if (!Number.isFinite(delta) || !isDriftPathAllowed(path)) continue;
    const scaled = round(clamp(delta * strength, -maxStep, maxStep));
    if (Math.abs(scaled) > Number.EPSILON) changes[path] = scaled;
  }

  const coreValues = {};
  for (const [path, value] of Object.entries(changes)) {
    if (path.startsWith('core_values.')) coreValues[path.slice('core_values.'.length)] = value;
  }

  return {
    event_type: type,
    duration_days: positiveDays(event.duration_days ?? options.durationDays ?? rule.duration_days, DEFAULT_DRIFT_DAYS),
    changes,
    core_values: coreValues,
    // 方便心跳层读取长期分离留下的动态印记。
    state_modifiers: Object.fromEntries(
      Object.entries(changes)
        .filter(([path]) => path.startsWith('state_modifiers.'))
        .map(([path, value]) => [path.slice('state_modifiers.'.length), value]),
    ),
    has_effect: Object.keys(changes).length > 0,
    source_personality: personality,
  };
}

/**
 * 创建稳定的漂移计划。from/target 被锁定，因此重复推进不会累计过冲。
 */
export function planPersonalityDrift(personality = {}, event = {}, options = {}) {
  const now = validDate(options.now ?? event.occurred_at, new Date());
  const base = normalizeForDrift(personality);
  const derived = derivePersonalityDelta(base, event, options);
  const from = {};
  const target = {};
  const effectiveChanges = {};

  for (const [path, requestedDelta] of Object.entries(derived.changes)) {
    const start = numericAtPath(base, path, defaultPathValue(path));
    const end = clampPathValue(path, start + requestedDelta);
    from[path] = start;
    target[path] = end;
    effectiveChanges[path] = round(end - start);
  }

  const durationMs = derived.duration_days * DAY_MS;
  const completesAt = new Date(now.getTime() + durationMs);
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : ({ type, startedAt }) => `${type}:${startedAt}`;
  const startedAt = now.toISOString();
  const id = String(idFactory({ type: derived.event_type, startedAt, event }));
  const hasEffect = Object.values(effectiveChanges).some((value) => Math.abs(value) > Number.EPSILON);

  return {
    id,
    event_type: derived.event_type,
    started_at: startedAt,
    completes_at: completesAt.toISOString(),
    duration_days: derived.duration_days,
    from,
    target,
    changes: effectiveChanges,
    delta: Object.fromEntries(
      Object.entries(effectiveChanges)
        .filter(([path]) => path.startsWith('core_values.'))
        .map(([path, value]) => [path.slice('core_values.'.length), value]),
    ),
    state_modifiers: Object.fromEntries(
      Object.entries(effectiveChanges)
        .filter(([path]) => path.startsWith('state_modifiers.'))
        .map(([path, value]) => [path.slice('state_modifiers.'.length), value]),
    ),
    progress: hasEffect ? 0 : 1,
    status: hasEffect ? 'scheduled' : 'no_effect',
  };
}

/**
 * 将一个计划推进到指定时刻。返回新对象，不修改 personality 或 plan。
 */
export function advancePersonalityDrift(personality = {}, plan = {}, options = {}) {
  const at = validDate(options.now ?? options.at, new Date());
  const progress = driftProgress(plan, at);
  const next = deepClone(normalizeForDrift(personality));
  const appliedDelta = {};

  for (const path of Object.keys(plan.changes || {})) {
    if (!isDriftPathAllowed(path)) continue;
    const start = finiteNumber(plan.from?.[path], numericAtPath(next, path, defaultPathValue(path)));
    const end = finiteNumber(plan.target?.[path], start + finiteNumber(plan.changes?.[path], 0));
    const value = clampPathValue(path, interpolate(start, end, progress));
    setAtPath(next, path, value);
    appliedDelta[path] = round(value - start);
  }

  const status = plan.status === 'no_effect'
    ? 'no_effect'
    : progress >= 1
      ? 'completed'
      : progress > 0
        ? 'in_progress'
        : 'scheduled';
  const advancedPlan = {
    ...deepClone(plan),
    progress,
    status,
    last_applied_at: at.toISOString(),
  };

  return {
    personality: next,
    drift: advancedPlan,
    progress,
    status,
    applied_delta: appliedDelta,
  };
}

export const applyDeltaGradually = advancePersonalityDrift;

/**
 * 顺序推进多个计划。适用于后台心跳取出 active_drifts 后一次结算。
 */
export function advancePersonalityDrifts(personality = {}, plans = [], options = {}) {
  let next = normalizeForDrift(personality);
  const drifts = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    const result = advancePersonalityDrift(next, plan, options);
    next = result.personality;
    drifts.push(result.drift);
  }
  return {
    personality: next,
    drifts,
    active_drifts: drifts.filter((drift) => !['completed', 'no_effect'].includes(drift.status)),
    completed_drifts: drifts.filter((drift) => drift.status === 'completed'),
  };
}

/**
 * 文档级异步入口。
 *
 * deps:
 * - loadPersonality(userId, event)
 * - savePersonality(userId, personality, meta)      可选
 * - scheduleDrift(userId, plan, meta)               可选
 * - now / durationDays / idFactory
 *
 * 也允许把 PersonalitySystem 直接作为第一个参数，用于无 IO 的纯逻辑调用。
 */
export async function applyDrift(userIdOrPersonality, event = {}, deps = {}) {
  const directPersonality = isPlainObject(userIdOrPersonality);
  let personality;
  let userId = null;

  if (directPersonality) {
    personality = userIdOrPersonality;
  } else {
    userId = userIdOrPersonality;
    if (typeof deps.loadPersonality !== 'function') {
      throw new TypeError('applyDrift requires deps.loadPersonality for a userId');
    }
    personality = await deps.loadPersonality(userId, event);
  }

  const plan = planPersonalityDrift(personality, event, deps);
  if (directPersonality) return plan;

  const normalized = normalizeForDrift(personality);
  const existing = Array.isArray(personality?.active_drifts) ? personality.active_drifts : [];
  const history = Array.isArray(personality?.drift_history) ? personality.drift_history : [];
  const scheduledPersonality = {
    ...personality,
    ...normalized,
    active_drifts: [...existing, plan],
    drift_history: [...history, plan].slice(-100),
    recent_drift: plan,
  };
  const meta = { event, plan };

  if (typeof deps.scheduleDrift === 'function') {
    await deps.scheduleDrift(userId, plan, { ...meta, personality: scheduledPersonality });
  }
  if (typeof deps.savePersonality === 'function') {
    await deps.savePersonality(userId, scheduledPersonality, meta);
  }

  return plan;
}

export function driftProgress(plan = {}, at = new Date()) {
  if (plan.status === 'no_effect') return 1;
  const start = validDate(plan.started_at, null);
  const end = validDate(plan.completes_at, null);
  const now = validDate(at, new Date());
  if (!start || !end || end.getTime() <= start.getTime()) return 1;
  return round(clamp01((now.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
}

function normalizeForDrift(personality) {
  const source = isPlainObject(personality) ? personality : {};
  const normalized = normalizePersonalitySystem(source);
  return {
    ...source,
    core_values: normalized.core_values,
    behavioral_patterns: normalized.behavioral_patterns,
    emotional_signature: normalized.emotional_signature,
    relational_modifier: normalized.relational_modifier,
    runtime_state: normalized.runtime_state,
    state_modifiers: isPlainObject(source.state_modifiers) ? { ...source.state_modifiers } : {},
  };
}

function normalizeCustomDelta(delta) {
  if (!isPlainObject(delta)) return {};
  const output = {};
  for (const [key, value] of Object.entries(delta)) {
    if (Number.isFinite(Number(value))) {
      const path = key.includes('.') ? key : `core_values.${key}`;
      output[path] = Number(value);
      continue;
    }
    if (!isPlainObject(value)) continue;
    flattenNumeric(value, key, output);
  }
  return output;
}

function flattenNumeric(value, prefix, output) {
  for (const [key, nested] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (Number.isFinite(Number(nested))) output[path] = Number(nested);
    else if (isPlainObject(nested)) flattenNumeric(nested, path, output);
  }
}

function isDriftPathAllowed(path) {
  return /^(core_values|emotional_signature|state_modifiers)\.[a-zA-Z0-9_.-]+$/.test(String(path));
}

function defaultPathValue(path) {
  if (path.endsWith('_multiplier')) return 1;
  return 0.5;
}

function clampPathValue(path, value) {
  if (path.endsWith('_multiplier')) return round(clamp(value, 0.25, 3, 1));
  return round(clamp01(value));
}

function numericAtPath(object, path, fallback) {
  const value = String(path).split('.').reduce((current, key) => current?.[key], object);
  return finiteNumber(value, fallback);
}

function setAtPath(object, path, value) {
  const keys = String(path).split('.');
  let current = object;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys.at(-1)] = value;
}

function interpolate(start, end, progress) {
  return start + (end - start) * progress;
}

function positiveDays(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(365, number) : fallback;
}

function clampPositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(1, number) : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validDate(value, fallback) {
  if (value == null) return fallback;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function clamp01(value, fallback = 0) {
  return clamp(value, 0, 1, fallback);
}

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
