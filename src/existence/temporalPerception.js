/**
 * M1 · Dead reckoning between messages.
 */

import {
  getDefaultContinuousStateStore,
  loadState,
  normalizeContinuousState,
} from './continuousState.js';
import {
  computeTemporalAnomaly,
  normalizeActivity,
} from './temporalPredictor.js';
import { DEFAULT_TIMEZONE_OFFSET_MINUTES } from './temporalPredictor.js';

const MINUTE = 60 * 1000;

export const ACTIVITY_MODEL = Object.freeze({
  driving: Object.freeze({ typical: 30, variance: 15, max: 90 }),
  eating: Object.freeze({ typical: 25, variance: 10, max: 60 }),
  sleeping: Object.freeze({ typical: 450, variance: 60, max: 600 }),
  working: Object.freeze({ typical: 240, variance: 60, max: 540 }),
  exercising: Object.freeze({ typical: 45, variance: 15, max: 90 }),
  showering: Object.freeze({ typical: 15, variance: 5, max: 30 }),
});

const ACTIVITY_LABELS = Object.freeze({
  driving: '开车这段路',
  eating: '吃饭',
  sleeping: '睡觉',
  working: '手头的工作',
  exercising: '运动',
  showering: '洗澡',
});

/**
 * Infer what likely happened since the last turn.
 *
 * Dependencies may be passed as the fourth argument, or as a third-argument
 * options object containing `now`.  This keeps the document's simple
 * (userId, companionId, now) call while allowing deterministic tests.
 */
export async function inferTimeGap(
  userId,
  companionId = 'default',
  now = new Date(),
  dependencies = {},
) {
  if (isDependencyOptions(now)) {
    dependencies = now;
    now = dependencies.now ?? new Date();
  }
  const actual = resolveDate(
    typeof now === 'function' ? now() : now,
    new Date(),
  );
  const store =
    dependencies.store ??
    dependencies.stateStore ??
    getDefaultContinuousStateStore();
  let state;
  try {
    state = dependencies.state
      ? normalizeContinuousState(dependencies.state, { now: actual })
      : dependencies.loadState
        ? normalizeContinuousState(
            await dependencies.loadState(userId, companionId),
            { now: actual },
          )
        : await loadState(userId, companionId, {
            store,
            now: actual.getTime(),
          });
  } catch (error) {
    if (dependencies.strict) throw error;
    state = normalizeContinuousState({}, { now: actual });
  }
  const elapsed = minutesSince(state.temporal.last_interaction, actual);
  const activeActivity =
    normalizeResolvedActivity(dependencies.activity) ??
    await resolveCurrentActivity(
      dependencies.activityResolver ?? dependencies.beliefs,
      { userId, companionId, at: actual },
      { strict: dependencies.strict },
    );
  const activity = normalizeActivity(activeActivity);
  const inferences = inferActivityProgress(activity, elapsed);
  const anomaly = state.temporal.expected_next
    ? detectTemporalAnomaly(
        elapsed,
        state.temporal.expected_next,
        activity,
        {
          now: actual,
          lastInteraction: state.temporal.last_interaction,
          predictor: dependencies.predictor,
        },
      )
    : null;
  const timeOfDay = getTimeContext(actual, {
    timezoneOffsetMinutes:
      dependencies.timezoneOffsetMinutes ??
      DEFAULT_TIMEZONE_OFFSET_MINUTES,
  });

  return {
    elapsed_minutes: round(elapsed, 3),
    inferences,
    anomaly,
    time_of_day_context: timeOfDay,
    active_activity: activity,
    narrative: buildNarrative(elapsed, inferences, anomaly, timeOfDay),
  };
}

export function inferActivityProgress(activity, elapsedMinutes) {
  const normalized = normalizeActivity(activity);
  const profile = ACTIVITY_MODEL[normalized];
  const elapsed = Math.max(0, finite(elapsedMinutes, 0));
  if (!profile) return [];
  const completion = elapsed / profile.typical;
  if (completion < 0.8) return [];
  return [
    {
      type: 'activity_likely_completed',
      activity: normalized,
      confidence: round(Math.min(0.95, completion * 0.7), 4),
      narrative: `${activityLabel(normalized)}应该已经结束`,
    },
  ];
}

export function detectTemporalAnomaly(
  elapsedOrActual,
  expectedNext,
  activeActivity = null,
  options = {},
) {
  if (!expectedNext) return null;
  let actual;
  if (elapsedOrActual instanceof Date || typeof elapsedOrActual === 'string') {
    actual = elapsedOrActual;
  } else if (options.now != null) {
    actual = typeof options.now === 'function' ? options.now() : options.now;
  } else if (options.lastInteraction != null) {
    const last = toEpoch(options.lastInteraction);
    actual =
      last == null
        ? null
        : last + Math.max(0, finite(elapsedOrActual, 0)) * MINUTE;
  } else if (
    typeof elapsedOrActual === 'number' &&
    typeof expectedNext === 'number' &&
    Math.abs(expectedNext) <= 30 * 24 * 60
  ) {
    // Pure gap overload: both arguments are minute counts.
    return computeTemporalAnomaly(
      new Date(expectedNext * MINUTE),
      new Date(Math.max(0, elapsedOrActual) * MINUTE),
      normalizeActivity(activeActivity),
    );
  } else if (typeof elapsedOrActual === 'number') {
    // The design sketch omits `now` from this helper's arguments.  Preserve
    // that shorthand for absolute expected timestamps.
    actual = Date.now();
  }
  if (actual == null) return null;
  if (typeof options.predictor?.computeAnomaly === 'function') {
    return options.predictor.computeAnomaly(
      expectedNext,
      actual,
      normalizeActivity(activeActivity),
    );
  }
  return computeTemporalAnomaly(
    expectedNext,
    actual,
    normalizeActivity(activeActivity),
  );
}

/**
 * Apply prediction error to the same state object supplied by the caller.
 */
export function applyAnomalyToState(anomaly, state) {
  if (!state || typeof state !== 'object') return state;
  const normalized = normalizeContinuousState(state);
  Object.assign(state, normalized);
  if (!anomaly || anomaly.type === 'normal') return state;
  const magnitude = Math.max(0, finite(anomaly.magnitude, 0));

  if (anomaly.type === 'too_fast') {
    state.emotional.current_emotion = 'surprised_pleasant';
    state.emotional.label = '期待';
    state.emotional.emotion_intensity = clamp01(magnitude / 30);
    state.emotional.valence = Math.max(
      state.emotional.valence,
      0.2 + state.emotional.emotion_intensity * 0.35,
    );
    state.emotional.persistence = Math.max(
      state.emotional.persistence,
      Math.min(30, magnitude),
    );
  } else if (anomaly.type === 'too_slow') {
    const worry = clamp01(magnitude / 60);
    if (worry > 0.5) {
      state.emotional.current_emotion = 'worried';
      state.emotional.label = '担心';
      state.emotional.emotion_intensity = worry;
      state.emotional.valence = Math.min(
        state.emotional.valence,
        -0.15 - worry * 0.35,
      );
      state.emotional.persistence = Math.max(
        state.emotional.persistence,
        Math.min(90, magnitude / 2),
      );
    }
  }
  return state;
}

/**
 * Mark the receipt of a real message.  The next-message prediction can be
 * supplied either in the predictor's result shape or as null.
 */
export function markInteraction(state, at = new Date(), prediction = null) {
  const date = resolveDate(at, new Date());
  const next = normalizeContinuousState(state, { now: date });
  next.temporal.last_interaction = date.toISOString();
  next.temporal.longing = 0;
  next.temporal.anticipation = 0;
  next.temporal.expected_next =
    validIso(prediction?.expected_at ?? prediction?.expectedAt);
  next.temporal.prediction_confidence = clamp01(prediction?.confidence);
  next.volitional.contact_inhibit = Math.max(
    next.volitional.contact_inhibit,
    0.65,
  );
  next.updated_at = date.toISOString();
  return next;
}

export function getTimeContext(
  at = new Date(),
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES } = {},
) {
  const epoch = toEpoch(at) ?? Date.now();
  const offset = clamp(
    Math.round(finite(timezoneOffsetMinutes, DEFAULT_TIMEZONE_OFFSET_MINUTES)),
    -14 * 60,
    14 * 60,
  );
  const wall = new Date(epoch + offset * MINUTE);
  const hour = wall.getUTCHours() + wall.getUTCMinutes() / 60;
  if (hour < 5) return 'late_night';
  if (hour < 9) return 'early_morning';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

export function buildNarrative(
  elapsedMinutes,
  inferences = [],
  anomaly = null,
  timeOfDayContext = null,
) {
  const elapsed = Math.max(0, finite(elapsedMinutes, 0));
  const parts = [];
  if (elapsed < 1) parts.push('刚刚才聊过');
  else if (elapsed < 10) parts.push(`只隔了${Math.max(1, Math.round(elapsed))}分钟`);
  else if (elapsed < 60) parts.push(`已经隔了大约${Math.round(elapsed)}分钟`);
  else if (elapsed < 180) parts.push(`安静了大约${formatDuration(elapsed)}`);
  else parts.push(`已经有${formatDuration(elapsed)}没说话了`);

  for (const inference of Array.isArray(inferences) ? inferences : []) {
    if (inference?.narrative) parts.push(String(inference.narrative));
  }
  if (anomaly?.type === 'too_fast') {
    parts.push(`比预期早了约${Math.round(anomaly.magnitude)}分钟`);
  } else if (anomaly?.type === 'too_slow') {
    parts.push(`比预期晚了约${Math.round(anomaly.magnitude)}分钟`);
  }
  if (timeOfDayContext === 'late_night') parts.push('现在已经是深夜');
  return `${parts.join('，')}。`;
}

export function temporalContextToPrompt(context) {
  if (!context?.narrative) return '';
  const anomalyGuidance =
    context.anomaly?.type === 'too_slow'
      ? '语气里可以有一点经过等待后的关切，但不要盘问或报时。'
      : context.anomaly?.type === 'too_fast'
        ? '可以自然流露一点意外的高兴，不要机械地说“这么快”。'
        : '自然承接这段真实经过的时间，不要像两条消息紧挨着发生。';
  return `【时间感知】${context.narrative}\n${anomalyGuidance}`;
}

export function minutesSince(from, to = Date.now()) {
  const start = toEpoch(from);
  const end = toEpoch(to);
  if (start == null || end == null) return 0;
  return Math.max(0, (end - start) / MINUTE);
}

export function activityLabel(activity) {
  const normalized = normalizeActivity(activity);
  return ACTIVITY_LABELS[normalized] ?? String(activity ?? '这件事');
}

async function resolveCurrentActivity(resolver, scope, { strict = false } = {}) {
  if (!resolver) return null;
  try {
    let result;
    if (typeof resolver === 'function') {
      result = await resolver(scope);
    } else if (typeof resolver.resolve === 'function' && resolver.userId) {
      // BeliefEngine instance.
      result = await resolver.resolve({
        predicate: 'current_activity',
        at: scope.at.toISOString(),
        limit: 1,
      });
    } else if (
      typeof resolver.resolve === 'function' &&
      resolver.constructor?.name === 'BeliefRepository'
    ) {
      result = await resolver.resolve(scope.userId, scope.companionId, {
        predicate: 'current_activity',
        at: scope.at.toISOString(),
        limit: 1,
      });
    } else if (typeof resolver.resolve === 'function') {
      // Documented lightweight resolver contract.
      result = await resolver.resolve('current_activity', {
        at: scope.at,
        userId: scope.userId,
        companionId: scope.companionId,
      });
    } else {
      return null;
    }
    return normalizeResolvedActivity(result);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

function normalizeResolvedActivity(result) {
  if (result == null) return null;
  const candidate =
    result.value ??
    result.activity ??
    result.object_value ??
    result.object_text ??
    result.belief?.object_value ??
    result.belief?.object_text ??
    result.beliefs?.[0]?.object_value ??
    result.beliefs?.[0]?.object_text ??
    result;
  const activity = normalizeActivity(candidate);
  return activity && activity !== '[object object]' ? activity : null;
}

function isDependencyOptions(value) {
  if (!value || value instanceof Date || typeof value !== 'object') return false;
  return [
    'now',
    'store',
    'stateStore',
    'state',
    'loadState',
    'beliefs',
    'activityResolver',
    'activity',
    'predictor',
  ].some((key) => Object.hasOwn(value, key));
}

function formatDuration(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  const hours = minutes / 60;
  if (hours < 24) {
    const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
    return `${rounded}小时`;
  }
  const days = hours / 24;
  const rounded = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
  return `${rounded}天`;
}

function resolveDate(value, fallback) {
  const epoch = toEpoch(value);
  return epoch == null ? fallback : new Date(epoch);
}

function validIso(value) {
  const epoch = toEpoch(value);
  return epoch == null ? null : new Date(epoch).toISOString();
}

function toEpoch(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
  }
  const epoch = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  return clamp(finite(value, 0), 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
