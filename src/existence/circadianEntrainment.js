/**
 * M1 · Circadian entrainment.
 *
 * Hours are represented on a 24-hour circular clock.  This matters for
 * windows such as [22, 0]: ordinary arithmetic would incorrectly blend that
 * window through noon.
 */

import {
  computeHourlyDistribution,
  DEFAULT_TIMEZONE_OFFSET_MINUTES,
  normalizeMessageHistory,
} from './temporalPredictor.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const DEFAULT_BASE_CLOCK = Object.freeze({
  peak_energy: Object.freeze([10, 16]),
  social_peak: Object.freeze([20, 22]),
  wind_down: Object.freeze([22.5, 0]),
  sleep_window: Object.freeze([0, 7.5]),
});

export class CircadianClock {
  constructor({
    baseClock = DEFAULT_BASE_CLOCK,
    historyLoader = async () => [],
    store = null,
    timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
    maxEntrainmentWeight = 0.6,
    fullEntrainmentDays = 90,
    clock = () => Date.now(),
  } = {}) {
    this.baseClock = normalizePersonalClock(baseClock);
    this.historyLoader = historyLoader;
    this.store = store;
    this.timezoneOffsetMinutes = normalizeTimezoneOffset(timezoneOffsetMinutes);
    this.maxEntrainmentWeight = clamp(finite(maxEntrainmentWeight, 0.6), 0, 1);
    this.fullEntrainmentDays = Math.max(1, finite(fullEntrainmentDays, 90));
    this.clock = clock;
  }

  async entrain(userId, history, options = {}) {
    let source = history;
    if (source == null) {
      try {
        source = await this.historyLoader(userId, options);
      } catch {
        source = [];
      }
    }
    const messages = Array.isArray(source)
      ? source
      : source?.messages ?? source?.data ?? [];
    const timezoneOffsetMinutes = normalizeTimezoneOffset(
      options.timezoneOffsetMinutes ?? this.timezoneOffsetMinutes,
    );
    const rhythm = extractUserRhythm(messages, { timezoneOffsetMinutes });
    const daysTogether = Math.max(
      0,
      finite(options.daysTogether, rhythm.days_observed),
    );
    const exposure = clamp(daysTogether / this.fullEntrainmentDays, 0, 1);
    // Sparse histories should not drag the companion clock as strongly as a
    // stable, well-observed rhythm.
    const evidence = clamp(rhythm.sample_count / 30, 0, 1);
    const weight =
      rhythm.sample_count > 0
        ? this.maxEntrainmentWeight * exposure * (0.5 + evidence * 0.5)
        : 0;
    const personal = {
      ...normalizePersonalClock(this.baseClock),
      social_peak: blendClockWindow(
        this.baseClock.social_peak,
        rhythm.active_hours,
        weight,
      ),
      entrainment_weight: round(weight, 4),
      user_rhythm: rhythm,
      updated_at: new Date(resolveEpoch(this.clock()) ?? Date.now()).toISOString(),
    };

    if (this.store?.save && userId) {
      await this.store.save(personal, { userId }).catch(() => {});
    }
    return personal;
  }

  fatigue(at = this.clock(), personalClock = this.baseClock) {
    return circadianFatigue(at, personalClock, {
      timezoneOffsetMinutes: this.timezoneOffsetMinutes,
    });
  }
}

export function extractUserRhythm(
  history,
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES } = {},
) {
  const messages = normalizeMessageHistory(
    Array.isArray(history) ? history : history?.messages ?? history?.data ?? [],
  );
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  const distribution = computeHourlyDistribution(messages, {
    timezoneOffsetMinutes: offset,
    smoothing: 0.05,
  });

  if (messages.length === 0) {
    return {
      active_hours: [...DEFAULT_BASE_CLOCK.social_peak],
      peak_hour: null,
      hourly_distribution: distribution,
      sample_count: 0,
      days_observed: 0,
      consistency: 0,
    };
  }

  // A rolling three-hour mass is more robust than selecting one noisy hour.
  let peakHour = 0;
  let peakMass = -1;
  for (let hour = 0; hour < 24; hour++) {
    const mass =
      distribution[(hour + 23) % 24] +
      distribution[hour] +
      distribution[(hour + 1) % 24];
    if (
      mass > peakMass ||
      (Math.abs(mass - peakMass) < 1e-12 &&
        distribution[hour] > distribution[peakHour])
    ) {
      peakMass = mass;
      peakHour = hour;
    }
  }

  const timestamps = messages.map((message) => message.timestamp);
  const spanDays =
    timestamps.length > 1
      ? (timestamps.at(-1) - timestamps[0]) / DAY + 1
      : 1;
  const dates = new Set(
    timestamps.map((timestamp) => wallDateKey(timestamp, offset)),
  );
  const uniformThreeHourMass = 3 / 24;
  const consistency = clamp(
    (peakMass - uniformThreeHourMass) / (1 - uniformThreeHourMass),
    0,
    1,
  );

  return {
    active_hours: [
      normalizeHour(peakHour - 1),
      normalizeHour(peakHour + 1),
    ],
    peak_hour: peakHour,
    hourly_distribution: distribution,
    sample_count: messages.length,
    days_observed: round(Math.max(dates.size, spanDays), 3),
    consistency: round(consistency, 4),
  };
}

export function normalizePersonalClock(clock = {}) {
  return {
    peak_energy: normalizeWindow(clock.peak_energy, DEFAULT_BASE_CLOCK.peak_energy),
    social_peak: normalizeWindow(clock.social_peak, DEFAULT_BASE_CLOCK.social_peak),
    wind_down: normalizeWindow(clock.wind_down, DEFAULT_BASE_CLOCK.wind_down),
    sleep_window: normalizeWindow(
      clock.sleep_window,
      DEFAULT_BASE_CLOCK.sleep_window,
    ),
  };
}

/**
 * Tiredness in [0, 1].  It is highest inside the sleep window, rises smoothly
 * in the three hours before sleep, and falls during the two hours after wake.
 */
export function circadianFatigue(
  at,
  personalClock = DEFAULT_BASE_CLOCK,
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES } = {},
) {
  const clock = normalizePersonalClock(personalClock);
  const hour = resolveHour(at, normalizeTimezoneOffset(timezoneOffsetMinutes));
  const [sleepStart, wakeAt] = clock.sleep_window;

  if (hourInWindow(hour, clock.sleep_window)) {
    const duration = forwardHours(sleepStart, wakeAt) || 8;
    const progress = clamp(forwardHours(sleepStart, hour) / duration, 0, 1);
    // 0.86 at the edges, 1.0 near the middle of sleep.
    return round(clamp(0.86 + Math.sin(Math.PI * progress) * 0.14, 0, 1), 4);
  }

  const untilSleep = forwardHours(hour, sleepStart);
  if (untilSleep <= 3) {
    return round(clamp(0.35 + (1 - untilSleep / 3) * 0.47, 0, 1), 4);
  }

  const sinceWake = forwardHours(wakeAt, hour);
  if (sinceWake <= 2) {
    return round(clamp(0.72 - (sinceWake / 2) * 0.5, 0, 1), 4);
  }

  // Mild post-lunch dip without pretending the companion is asleep.
  const afternoonDip = 0.13 * Math.exp(-0.5 * ((hour - 14.5) / 1.4) ** 2);
  return round(clamp(0.18 + afternoonDip, 0, 1), 4);
}

export function circadianEnergy(at, personalClock, options) {
  return round(1 - circadianFatigue(at, personalClock, options), 4);
}

export function blendClockWindow(base, target, weight = 0.5) {
  const left = normalizeWindow(base, [0, 0]);
  const right = normalizeWindow(target, left);
  const amount = clamp(finite(weight, 0.5), 0, 1);
  return [
    round(blendHour(left[0], right[0], amount), 4),
    round(blendHour(left[1], right[1], amount), 4),
  ];
}

/**
 * Public helper matching the design document.  Numeric values use ordinary
 * interpolation; two-hour clock windows use circular interpolation.
 */
export function blend(base, target, weight = 0.5) {
  if (Array.isArray(base) || Array.isArray(target)) {
    return blendClockWindow(base, target, weight);
  }
  const amount = clamp(finite(weight, 0.5), 0, 1);
  return finite(base, 0) + (finite(target, finite(base, 0)) - finite(base, 0)) * amount;
}

export function blendHour(from, to, weight = 0.5) {
  const start = normalizeHour(from);
  const end = normalizeHour(to);
  const amount = clamp(finite(weight, 0.5), 0, 1);
  let delta = (((end - start + 12) % 24) + 24) % 24 - 12;
  // Make the exact twelve-hour tie deterministic.
  if (delta === -12 && end > start) delta = 12;
  return normalizeHour(start + delta * amount);
}

export function hourInWindow(hour, window) {
  const h = normalizeHour(hour);
  const [start, end] = normalizeWindow(window, [0, 0]);
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

export function forwardHours(from, to) {
  return (normalizeHour(to) - normalizeHour(from) + 24) % 24;
}

function normalizeWindow(value, fallback) {
  if (!Array.isArray(value) || value.length < 2) return [...fallback];
  return [normalizeHour(value[0]), normalizeHour(value[1])];
}

function resolveHour(value, timezoneOffsetMinutes) {
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 48) {
    return normalizeHour(value);
  }
  const epoch = resolveEpoch(value) ?? Date.now();
  return new Date(epoch + timezoneOffsetMinutes * MINUTE).getUTCHours() +
    new Date(epoch + timezoneOffsetMinutes * MINUTE).getUTCMinutes() / 60;
}

function resolveEpoch(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
  }
  const epoch = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function wallDateKey(epoch, timezoneOffsetMinutes) {
  const date = new Date(epoch + timezoneOffsetMinutes * MINUTE);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function normalizeTimezoneOffset(value) {
  return clamp(
    Math.round(finite(value, DEFAULT_TIMEZONE_OFFSET_MINUTES)),
    -14 * 60,
    14 * 60,
  );
}

function normalizeHour(value) {
  const number = finite(value, 0);
  return ((number % 24) + 24) % 24;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
