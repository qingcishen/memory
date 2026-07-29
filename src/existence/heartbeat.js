/**
 * M0 · Continuous heartbeat.
 *
 * No timer is started at import time.  The caller owns lifecycle via
 * startHeartbeat(), which prevents overlapping ticks and exposes stop().
 */

import {
  defaultContinuousState,
  getDefaultContinuousStateStore,
  loadState,
  normalizeContinuousState,
  saveState,
} from './continuousState.js';
import {
  circadianFatigue,
  DEFAULT_BASE_CLOCK,
} from './circadianEntrainment.js';

const MINUTE = 60 * 1000;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_EMOTION_DECAY_LAMBDA = 0.15;
export const DEFAULT_LONGING_GROWTH_LAMBDA = 0.03;

export async function heartbeatTick(
  userId,
  companionId = 'default',
  options = {},
) {
  if (companionId && typeof companionId === 'object') {
    options = companionId;
    companionId = options.companionId ?? 'default';
  }
  const now = resolveDate(resolveClock(options.clock ?? options.now), new Date());
  const store =
    options.store ??
    options.stateStore ??
    getDefaultContinuousStateStore();
  let state;
  try {
    state = options.state
      ? normalizeContinuousState(options.state, { now })
      : options.loadState
        ? normalizeContinuousState(
            await options.loadState(userId, companionId),
            { now },
          )
        : await loadState(userId, companionId, {
            store,
            now: now.getTime(),
          });
  } catch (error) {
    if (options.strict) throw error;
    state = defaultContinuousState(now);
  }
  const elapsedMinutes = minutesSince(state.updated_at, now);

  let personalClock = options.personalClock ?? DEFAULT_BASE_CLOCK;
  if (typeof options.getPersonalClock === 'function') {
    try {
      personalClock =
        await options.getPersonalClock({ userId, companionId, now }) ??
        personalClock;
    } catch (error) {
      if (options.strict) throw error;
    }
  }

  state = evolveContinuousState(state, now, {
    emotionDecayLambda: options.emotionDecayLambda,
    longingGrowthLambda: options.longingGrowthLambda,
    anticipationUncertaintyMinutes:
      options.anticipationUncertaintyMinutes,
    personalClock,
    circadianClock: options.circadianClock,
    timezoneOffsetMinutes: options.timezoneOffsetMinutes,
  });

  const computeDesire =
    options.computeDesire ??
    options.computeDesireFn ??
    computeDefaultDesire;
  try {
    const result = await computeDesire(state, {
      userId,
      companionId,
      now,
    });
    if (result && typeof result === 'object') {
      state.volitional.proactive_desire = clamp01(
        result.score ?? result.desire ?? result.proactive_desire,
      );
      state.volitional.desire_reason =
        textOrNull(result.reason ?? result.desire_reason) ??
        state.volitional.desire_reason;
    } else {
      state.volitional.proactive_desire = clamp01(result);
    }
  } catch (error) {
    if (options.strict) throw error;
    state.volitional.proactive_desire = computeDefaultDesire(state);
  }

  const contactCheck =
    options.checkProactiveContact ??
    options.checkContact ??
    null;
  let contactDecision = null;
  if (typeof contactCheck === 'function') {
    try {
      contactDecision = await contactCheck(
        userId,
        companionId,
        state,
        { now },
      );
    } catch (error) {
      if (options.strict) throw error;
      if (typeof options.onError === 'function') {
        options.onError(error, { phase: 'proactive_contact' });
      }
    }
  }

  state.updated_at = now.toISOString();
  state = normalizeContinuousState(state, { now });
  try {
    let saved;
    if (options.saveState) {
      const result = await options.saveState(userId, companionId, state);
      saved = result == null
        ? state
        : normalizeContinuousState(result, { now });
    } else {
      saved = await saveState(userId, companionId, state, {
        store,
        now: now.getTime(),
      });
    }
    return heartbeatResult(saved, {
      contactDecision,
      elapsedMinutes,
      detailed: options.detailed,
    });
  } catch (error) {
    if (options.strict) throw error;
    if (typeof options.onError === 'function') {
      options.onError(error, { phase: 'save' });
    }
    return heartbeatResult(state, {
      contactDecision,
      elapsedMinutes,
      detailed: options.detailed,
    });
  }
}

/**
 * Detailed heartbeat contract for runtime façades that need the proactive
 * decision as well as the persisted state.
 */
export function heartbeatStep(
  userId,
  companionId = 'default',
  options = {},
) {
  if (companionId && typeof companionId === 'object') {
    options = companionId;
    companionId = options.companionId ?? 'default';
  }
  return heartbeatTick(userId, companionId, { ...options, detailed: true });
}

/**
 * Pure state transition used by heartbeatTick and unit tests.
 */
export function evolveContinuousState(state, now = new Date(), options = {}) {
  const date = resolveDate(now, new Date());
  const current = normalizeContinuousState(state, { now: date });
  const elapsed = minutesSince(current.updated_at, date);
  const emotionLambda = nonNegative(
    options.emotionDecayLambda,
    DEFAULT_EMOTION_DECAY_LAMBDA,
  );
  const longingLambda = nonNegative(
    options.longingGrowthLambda,
    DEFAULT_LONGING_GROWTH_LAMBDA,
  );

  const emotionalDecay = decayFactor(elapsed, emotionLambda);
  current.emotional.emotion_intensity = clamp01(
    current.emotional.emotion_intensity * emotionalDecay,
  );
  current.emotional.valence = clamp(
    current.emotional.valence *
      decayFactor(elapsed, emotionLambda * 0.45),
    -1,
    1,
  );
  current.emotional.persistence = Math.max(
    0,
    current.emotional.persistence - elapsed,
  );
  if (
    current.emotional.emotion_intensity < 0.005 &&
    current.emotional.persistence <= 0
  ) {
    current.emotional.current_emotion = 'neutral';
    current.emotional.emotion_intensity = 0;
  }

  // Asymptotic growth is stable regardless of whether one ten-minute tick or
  // twenty thirty-second ticks were used.
  current.temporal.longing = clamp01(
    current.temporal.longing +
      (1 - current.temporal.longing) * growFactor(elapsed, longingLambda),
  );

  const circadian = options.circadianClock;
  current.temporal.fatigue = clamp01(
    typeof circadian?.fatigue === 'function'
      ? circadian.fatigue(date, options.personalClock)
      : circadianFatigue(date, options.personalClock ?? DEFAULT_BASE_CLOCK, {
          ...(options.timezoneOffsetMinutes == null
            ? {}
            : {
                timezoneOffsetMinutes: options.timezoneOffsetMinutes,
              }),
        }),
  );

  if (current.temporal.expected_next) {
    const timeToExpected = minutesUntil(
      current.temporal.expected_next,
      date,
    );
    current.temporal.anticipation = anticipationCurve(
      timeToExpected,
      options.anticipationUncertaintyMinutes,
    );
  } else {
    current.temporal.anticipation = clamp01(
      current.temporal.anticipation * decayFactor(elapsed, 0.08),
    );
  }

  // "Just contacted" inhibition should fade even while no messages arrive.
  current.volitional.contact_inhibit = clamp01(
    current.volitional.contact_inhibit * decayFactor(elapsed, 0.035),
  );
  current.updated_at = date.toISOString();
  return current;
}

export function computeDefaultDesire(state = {}) {
  const normalized = normalizeContinuousState(state);
  const {
    temporal: { longing, anticipation },
    cognitive: { unfinished_topics: unfinished, memory_surfaced: memory },
    emotional: { emotion_intensity: intensity, valence },
    volitional: { contact_inhibit: inhibit },
  } = normalized;
  const drivers = [
    ['longing', longing * 0.3],
    ['unfinished_topic', Math.min(1, unfinished.length * 0.2) * 0.2],
    ['memory_surfaced', (memory ? 0.7 : 0) * 0.15],
    ['anticipation', anticipation * 0.15],
    ['emotion', intensity * (valence > 0 ? 1 : 0.5) * 0.2],
  ];
  const raw = drivers.reduce((sum, [, score]) => sum + score, 0);
  return clamp01(raw - inhibit);
}

/**
 * I-2: 从亲密状态计算性张力对主动欲望的额外加成。
 * sexual_tension > 0.6 且久未亲密（> 2 天）时才启动，上限 +0.2。
 * 纯函数；不改写亲密状态本身。
 */
export function intimacyTensionDesireBump(intimacy = null) {
  if (!intimacy || typeof intimacy !== 'object') return 0;
  const tension = Math.min(1, Math.max(0, Number(intimacy.sexual_tension) || 0));
  if (tension <= 0.6) return 0;
  const lastAt = intimacy.last_intimate_at ? new Date(intimacy.last_intimate_at).getTime() : 0;
  const daysSince = lastAt ? (Date.now() - lastAt) / (24 * 60 * 60 * 1000) : 999;
  if (daysSince <= 2) return 0;
  const intensity = (tension - 0.6) / 0.4;
  const staleness = Math.min(1, (daysSince - 2) / 5);
  return Math.min(0.2, intensity * staleness * 0.2);
}

export function dominantDesireReason(state = {}) {
  const normalized = normalizeContinuousState(state);
  const candidates = [
    ['longing', normalized.temporal.longing * 0.3],
    [
      'unfinished_topic',
      Math.min(1, normalized.cognitive.unfinished_topics.length * 0.2) *
        0.2,
    ],
    ['memory_surfaced', normalized.cognitive.memory_surfaced ? 0.105 : 0],
    ['anticipation', normalized.temporal.anticipation * 0.15],
    [
      'emotion',
      normalized.emotional.emotion_intensity *
        (normalized.emotional.valence > 0 ? 0.2 : 0.1),
    ],
  ];
  const [reason, score] = candidates.sort((a, b) => b[1] - a[1])[0];
  return score > 0 ? reason : null;
}

export function decayFactor(elapsedMinutes, lambda = 0.15) {
  const rawElapsed = Number(elapsedMinutes);
  const rawRate = Number(lambda);
  const elapsed =
    rawElapsed === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Number.isFinite(rawElapsed) ? rawElapsed : 0);
  const rate =
    rawRate === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Number.isFinite(rawRate) ? rawRate : 0);
  if (elapsed === 0 || rate === 0) return 1;
  if (elapsed === Number.POSITIVE_INFINITY && rate > 0) return 0;
  if (rate === Number.POSITIVE_INFINITY && elapsed > 0) return 0;
  return clamp(Math.exp(-rate * elapsed), 0, 1);
}

export function growFactor(elapsedMinutes, lambda = 0.03) {
  return 1 - decayFactor(elapsedMinutes, lambda);
}

/**
 * Anticipation peaks at the expected moment and gradually falls after a miss.
 */
export function anticipationCurve(
  timeToExpectedMinutes,
  uncertaintyMinutes = 60,
) {
  const delta = finite(timeToExpectedMinutes, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(delta)) return 0;
  const spread = Math.max(5, finite(uncertaintyMinutes, 60));
  const sideScale = delta < 0 ? spread * 1.35 : spread;
  return round(
    clamp(Math.exp(-0.5 * (Math.abs(delta) / sideScale) ** 2), 0, 1),
    6,
  );
}

export function minutesSince(from, to = Date.now()) {
  const start = toEpoch(from);
  const end = toEpoch(to);
  if (start == null || end == null) return 0;
  return Math.max(0, (end - start) / MINUTE);
}

export function minutesUntil(target, from = Date.now()) {
  const targetEpoch = toEpoch(target);
  const fromEpoch = toEpoch(from);
  if (targetEpoch == null || fromEpoch == null) return Number.POSITIVE_INFINITY;
  return (targetEpoch - fromEpoch) / MINUTE;
}

export function startHeartbeat(
  userId,
  companionId = 'default',
  options = {},
) {
  if (userId && typeof userId === 'object') {
    options = userId;
    userId = options.userId;
    companionId = options.companionId ?? 'default';
  } else if (companionId && typeof companionId === 'object') {
    options = companionId;
    companionId = options.companionId ?? 'default';
  }
  if (!String(userId ?? '').trim()) {
    throw new Error('startHeartbeat requires userId');
  }

  const intervalMs = Math.max(
    1,
    finite(options.intervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS),
  );
  const tickFn = options.tick ?? heartbeatTick;
  const schedule = options.setIntervalFn ?? setInterval;
  const cancel = options.clearIntervalFn ?? clearInterval;
  let stopped = false;
  let inFlight = null;

  const run = () => {
    if (stopped) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() =>
        tickFn(userId, companionId, options.tickOptions ?? options),
      )
      .catch((error) => {
        if (typeof options.onError === 'function') {
          options.onError(error, { phase: 'tick' });
          return null;
        }
        if (options.strict) throw error;
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = schedule(() => {
    void run();
  }, intervalMs);
  if (options.unref !== false && typeof timer?.unref === 'function') {
    timer.unref();
  }
  if (options.immediate) void run();

  return {
    timer,
    tick: run,
    stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    },
    get running() {
      return inFlight != null;
    },
    get stopped() {
      return stopped;
    },
  };
}

export function stopHeartbeat(controller) {
  controller?.stop?.();
}

function heartbeatResult(
  state,
  { contactDecision = null, elapsedMinutes = 0, detailed = false } = {},
) {
  if (!detailed) return state;
  return {
    state,
    continuousState: state,
    contactDecision,
    elapsed_minutes: round(Math.max(0, finite(elapsedMinutes, 0)), 3),
    updated_at: state.updated_at,
  };
}

function resolveClock(value) {
  if (typeof value === 'function') return value();
  return value ?? Date.now();
}

function resolveDate(value, fallback) {
  const epoch = toEpoch(value);
  return epoch == null ? fallback : new Date(epoch);
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

function nonNegative(value, fallback) {
  return Math.max(0, finite(value, fallback));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
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
