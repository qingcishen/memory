/**
 * M1 · Predictive temporal coding.
 *
 * The predictor deliberately has no database import.  A caller can inject any
 * recent-message loader; an absent loader simply produces a low-confidence
 * prior, which keeps local and credential-free runs deterministic.
 */

export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 8 * 60;
export const DEFAULT_LOOKBACK_DAYS = 30;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIFORM_HOUR_PROBABILITY = 1 / 24;

const ACTIVITY_THRESHOLDS = Object.freeze({
  driving: 15,
  eating: 10,
  sleeping: 60,
  working: 60,
  exercising: 15,
  showering: 5,
  idle: 20,
});

const CONTEXT_GAPS = Object.freeze({
  driving: 30,
  eating: 25,
  sleeping: 450,
  working: 240,
  exercising: 45,
  showering: 15,
  before_sleep: 450,
});

export class TemporalPredictor {
  constructor({
    getRecentMessages = async () => [],
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
    clock = () => Date.now(),
    strict = false,
  } = {}) {
    this.getRecentMessages = getRecentMessages;
    this.lookbackDays = clamp(finite(lookbackDays, DEFAULT_LOOKBACK_DAYS), 1, 365);
    this.timezoneOffsetMinutes = normalizeTimezoneOffset(timezoneOffsetMinutes);
    this.clock = clock;
    this.strict = Boolean(strict);
  }

  async learnPattern(userId, options = {}) {
    let result = [];
    try {
      result = await this.getRecentMessages(
        userId,
        options.days ?? this.lookbackDays,
        options,
      );
    } catch (error) {
      if (this.strict) throw error;
    }
    const messages = normalizeMessageHistory(result?.data ?? result, {
      userOnly: options.userOnly !== false,
    });
    const timezoneOffsetMinutes = normalizeTimezoneOffset(
      options.timezoneOffsetMinutes ?? this.timezoneOffsetMinutes,
    );
    return buildUserTimePattern(messages, { timezoneOffsetMinutes });
  }

  async predictNextMessage(userId, lastMsgTime, context = null, options = {}) {
    const pattern = options.pattern ?? await this.learnPattern(userId, options);
    const last = toEpoch(lastMsgTime) ?? toEpoch(this.clock()) ?? Date.now();
    const prediction = computeExpectedTime(pattern, last, context, {
      timezoneOffsetMinutes:
        options.timezoneOffsetMinutes ?? this.timezoneOffsetMinutes,
      horizonMinutes: options.horizonMinutes,
      stepMinutes: options.stepMinutes,
    });
    return {
      expected_at: new Date(prediction.expectedAt).toISOString(),
      confidence: computeConfidence(pattern),
      uncertainty_minutes: computeUncertainty(pattern),
      sample_count: pattern.sample_count ?? 0,
      context: normalizeActivity(context),
    };
  }

  computeAnomaly(predicted, actual, activity = null) {
    return computeTemporalAnomaly(predicted, actual, activity);
  }
}

export function buildUserTimePattern(
  messages,
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES } = {},
) {
  const normalized = normalizeMessageHistory(messages);
  return {
    hourly_distribution: computeHourlyDistribution(normalized, {
      timezoneOffsetMinutes,
    }),
    gap_distribution: computeGapDistribution(normalized),
    weekday_modifiers: computeWeekdayModifiers(normalized, {
      timezoneOffsetMinutes,
    }),
    contextual_patterns: computeContextualPatterns(normalized, {
      timezoneOffsetMinutes,
    }),
    sample_count: normalized.length,
    first_message_at: normalized.length
      ? new Date(normalized[0].timestamp).toISOString()
      : null,
    last_message_at: normalized.length
      ? new Date(normalized.at(-1).timestamp).toISOString()
      : null,
    timezone_offset_minutes: normalizeTimezoneOffset(timezoneOffsetMinutes),
  };
}

export function normalizeMessageHistory(messages, { userOnly = true } = {}) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  for (const message of messages) {
    if (userOnly && !isUserMessage(message)) continue;
    const timestamp = extractMessageTime(message);
    if (timestamp == null) continue;
    normalized.push({ ...message, timestamp });
  }
  normalized.sort((a, b) => a.timestamp - b.timestamp);
  return normalized;
}

export function extractMessageTime(message) {
  if (message instanceof Date || typeof message === 'number' || typeof message === 'string') {
    return toEpoch(message);
  }
  if (!message || typeof message !== 'object') return null;
  return toEpoch(
    message.created_at ??
      message.createdAt ??
      message.sent_at ??
      message.sentAt ??
      message.timestamp ??
      message.ts ??
      message.time,
  );
}

export function computeHourlyDistribution(
  messages,
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES, smoothing = 0.25 } = {},
) {
  const counts = Array(24).fill(Math.max(0, finite(smoothing, 0.25)));
  const normalized = normalizeMessageHistory(messages);
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  for (const message of normalized) {
    counts[wallClockParts(message.timestamp, offset).hour] += 1;
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return Array(24).fill(UNIFORM_HOUR_PROBABILITY);
  return counts.map((value) => value / total);
}

export const computeHourlyDist = computeHourlyDistribution;

export function computeGapDistribution(messages) {
  const normalized = normalizeMessageHistory(messages);
  const gaps = [];
  for (let index = 1; index < normalized.length; index++) {
    const gap = (normalized[index].timestamp - normalized[index - 1].timestamp) / MINUTE;
    // Duplicate/out-of-order timestamps carry no timing signal.  Very long
    // gaps are retained (up to 30 days) because they are meaningful absences.
    if (Number.isFinite(gap) && gap > 0 && gap <= 30 * 24 * 60) gaps.push(gap);
  }
  if (gaps.length === 0) {
    return {
      count: 0,
      mean_minutes: null,
      median_minutes: null,
      standard_deviation_minutes: null,
      p25_minutes: null,
      p75_minutes: null,
      min_minutes: null,
      max_minutes: null,
    };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  const variance =
    gaps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gaps.length;
  return {
    count: gaps.length,
    mean_minutes: round(mean, 3),
    median_minutes: round(quantile(sorted, 0.5), 3),
    standard_deviation_minutes: round(Math.sqrt(variance), 3),
    p25_minutes: round(quantile(sorted, 0.25), 3),
    p75_minutes: round(quantile(sorted, 0.75), 3),
    min_minutes: round(sorted[0], 3),
    max_minutes: round(sorted.at(-1), 3),
  };
}

export const computeGapDist = computeGapDistribution;

export function computeWeekdayModifiers(
  messages,
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES, smoothing = 1 } = {},
) {
  const normalized = normalizeMessageHistory(messages);
  const prior = Math.max(0.01, finite(smoothing, 1));
  const counts = Array(7).fill(prior);
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  for (const message of normalized) {
    counts[wallClockParts(message.timestamp, offset).weekday] += 1;
  }
  const mean = counts.reduce((sum, count) => sum + count, 0) / 7;
  return counts.map((count) => round(count / mean, 6));
}

export const computeWeekdayMod = computeWeekdayModifiers;

export function computeContextualPatterns(
  messages,
  { timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES } = {},
) {
  const normalized = normalizeMessageHistory(messages);
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  const buckets = {
    morning: 0,
    afternoon: 0,
    evening: 0,
    late_night: 0,
    weekday: 0,
    weekend: 0,
  };
  for (const message of normalized) {
    const { hour, weekday } = wallClockParts(message.timestamp, offset);
    if (hour >= 6 && hour < 12) buckets.morning += 1;
    else if (hour >= 12 && hour < 18) buckets.afternoon += 1;
    else if (hour >= 18 && hour < 24) buckets.evening += 1;
    else buckets.late_night += 1;
    if (weekday === 0 || weekday === 6) buckets.weekend += 1;
    else buckets.weekday += 1;
  }
  const count = normalized.length;
  const hourly = computeHourlyDistribution(normalized, {
    timezoneOffsetMinutes: offset,
  });
  const peakHour = hourly.indexOf(Math.max(...hourly));
  return {
    sample_count: count,
    peak_hour: count > 0 ? peakHour : null,
    morning_probability: ratio(buckets.morning, count),
    afternoon_probability: ratio(buckets.afternoon, count),
    evening_probability: ratio(buckets.evening, count),
    late_night_probability: ratio(buckets.late_night, count),
    weekday_probability: ratio(buckets.weekday, count),
    weekend_probability: ratio(buckets.weekend, count),
  };
}

/**
 * Find the most likely five/ten-minute bucket after the last message.
 */
export function computeExpectedTime(
  pattern,
  lastMsgTime,
  context = null,
  {
    timezoneOffsetMinutes = pattern?.timezone_offset_minutes ??
      DEFAULT_TIMEZONE_OFFSET_MINUTES,
    horizonMinutes = 48 * 60,
    stepMinutes = 10,
  } = {},
) {
  const last = toEpoch(lastMsgTime) ?? Date.now();
  const gap = pattern?.gap_distribution ?? {};
  const activity = normalizeActivity(context);
  const contextualGap = CONTEXT_GAPS[activity];
  const learnedGap = positiveFinite(
    gap.median_minutes ?? gap.mean_minutes,
    null,
  );
  const baseGap = learnedGap == null
    ? contextualGap ?? 60
    : contextualGap
      ? learnedGap * 0.7 + contextualGap * 0.3
      : learnedGap;
  const uncertainty = computeUncertainty(pattern);

  if (!(pattern?.sample_count > 0)) {
    return {
      expectedAt: last + Math.max(5, baseGap) * MINUTE,
      expected_gap_minutes: Math.max(5, baseGap),
      score: 0,
    };
  }

  const hourly = normalizeHourlyDistribution(pattern.hourly_distribution);
  const weekdays = normalizeWeekdayModifiers(pattern.weekday_modifiers);
  const horizon = clamp(finite(horizonMinutes, 48 * 60), 15, 14 * 24 * 60);
  const step = clamp(finite(stepMinutes, 10), 1, 60);
  const minimumGap = step;
  let best = {
    expectedAt: last + Math.max(minimumGap, baseGap) * MINUTE,
    expected_gap_minutes: Math.max(minimumGap, baseGap),
    score: -1,
  };

  for (let delay = minimumGap; delay <= horizon; delay += step) {
    const candidate = last + delay * MINUTE;
    const { hour, weekday } = wallClockParts(
      candidate,
      normalizeTimezoneOffset(timezoneOffsetMinutes),
    );
    const hourWeight = Math.max(0.05, hourly[hour] / UNIFORM_HOUR_PROBABILITY);
    const weekdayWeight = Math.max(0.1, weekdays[weekday]);
    const spread = Math.max(10, uncertainty);
    const gapWeight = Math.exp(-0.5 * ((delay - baseGap) / spread) ** 2);
    // A tiny recency penalty breaks equal-score ties in favour of the earlier
    // plausible moment.
    const recencyWeight = Math.exp(-delay / (14 * 24 * 60));
    const score = hourWeight * weekdayWeight * gapWeight * recencyWeight;
    if (score > best.score) {
      best = {
        expectedAt: candidate,
        expected_gap_minutes: delay,
        score,
      };
    }
  }
  return best;
}

export function computeConfidence(pattern = {}) {
  const count = Math.max(0, finite(pattern.sample_count, 0));
  if (count < 2) return 0;
  const sampleFactor = 1 - Math.exp(-count / 20);
  const hourly = normalizeHourlyDistribution(pattern.hourly_distribution);
  const entropy = -hourly.reduce(
    (sum, probability) =>
      sum + (probability > 0 ? probability * Math.log(probability) : 0),
    0,
  );
  const concentration = clamp(1 - entropy / Math.log(24), 0, 1);
  const gaps = pattern.gap_distribution ?? {};
  const mean = positiveFinite(gaps.mean_minutes, null);
  const deviation = positiveFinite(gaps.standard_deviation_minutes, null);
  const regularity =
    mean == null || deviation == null
      ? 0.35
      : clamp(1 - deviation / Math.max(mean * 1.5, 1), 0.05, 1);
  return round(
    clamp(sampleFactor * (0.45 + concentration * 0.25 + regularity * 0.3), 0, 0.98),
    4,
  );
}

export function computeUncertainty(pattern = {}) {
  const gaps = pattern.gap_distribution ?? {};
  if (!(gaps.count > 0)) return 180;
  const iqr =
    positiveFinite(gaps.p75_minutes, 0) - positiveFinite(gaps.p25_minutes, 0);
  const deviation = positiveFinite(gaps.standard_deviation_minutes, 0);
  const median = positiveFinite(gaps.median_minutes, 60);
  const sparsePrior = median * (gaps.count >= 10 ? 0.01 : 0.15);
  const estimate = Math.max(iqr / 2, deviation, sparsePrior);
  return round(clamp(estimate, 5, 24 * 60), 2);
}

export function computeTemporalAnomaly(predicted, actual, activity = null) {
  const threshold = getActivityThreshold(activity);
  const diff = minutesBetween(predicted, actual);
  if (diff == null) {
    return {
      type: 'normal',
      magnitude: 0,
      signed_delta_minutes: 0,
      threshold_minutes: threshold,
    };
  }
  if (diff < -threshold * 0.5) {
    return {
      type: 'too_fast',
      magnitude: round(Math.abs(diff), 3),
      signed_delta_minutes: round(diff, 3),
      threshold_minutes: threshold,
    };
  }
  if (diff > threshold * 1.5) {
    return {
      type: 'too_slow',
      magnitude: round(diff, 3),
      signed_delta_minutes: round(diff, 3),
      threshold_minutes: threshold,
    };
  }
  return {
    type: 'normal',
    magnitude: round(Math.abs(diff), 3),
    signed_delta_minutes: round(diff, 3),
    threshold_minutes: threshold,
  };
}

export function minutesBetween(predicted, actual) {
  const left = toEpoch(predicted);
  const right = toEpoch(actual);
  if (left == null || right == null) return null;
  return (right - left) / MINUTE;
}

export function getActivityThreshold(activity) {
  return ACTIVITY_THRESHOLDS[normalizeActivity(activity)] ?? 20;
}

export function normalizeActivity(value) {
  const raw =
    value && typeof value === 'object'
      ? value.value ?? value.object_value ?? value.object_text ?? value.activity
      : value;
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/睡前|before.?sleep/.test(text)) return 'before_sleep';
  if (/驾|开车|drive|路上/.test(text)) return 'driving';
  if (/吃|饭|eat|餐/.test(text)) return 'eating';
  if (/睡|sleep|nap/.test(text)) return 'sleeping';
  if (/工作|上班|开会|work/.test(text)) return 'working';
  if (/运动|健身|跑步|exercise|workout/.test(text)) return 'exercising';
  if (/洗澡|淋浴|shower/.test(text)) return 'showering';
  if (/空闲|休息|idle|free/.test(text)) return 'idle';
  return text;
}

function isUserMessage(message) {
  if (!message || typeof message !== 'object') return true;
  const role = String(
    message.role ?? message.sender ?? message.author_role ?? '',
  ).toLowerCase();
  if (!role) return true;
  return ['user', 'human', 'inbound'].includes(role);
}

function normalizeHourlyDistribution(value) {
  if (!Array.isArray(value) || value.length !== 24) {
    return Array(24).fill(UNIFORM_HOUR_PROBABILITY);
  }
  const values = value.map((entry) => Math.max(0, finite(entry, 0)));
  const total = values.reduce((sum, entry) => sum + entry, 0);
  return total > 0
    ? values.map((entry) => entry / total)
    : Array(24).fill(UNIFORM_HOUR_PROBABILITY);
}

function normalizeWeekdayModifiers(value) {
  if (!Array.isArray(value) || value.length !== 7) return Array(7).fill(1);
  return value.map((entry) => clamp(finite(entry, 1), 0.05, 7));
}

function wallClockParts(timestamp, timezoneOffsetMinutes) {
  const shifted = new Date(timestamp + timezoneOffsetMinutes * MINUTE);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

function normalizeTimezoneOffset(value) {
  return clamp(
    Math.round(finite(value, DEFAULT_TIMEZONE_OFFSET_MINUTES)),
    -14 * 60,
    14 * 60,
  );
}

function toEpoch(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Accept both Unix seconds and JavaScript milliseconds.
    return Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
  }
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function quantile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function ratio(value, total) {
  return total > 0 ? round(value / total, 6) : 0;
}

function positiveFinite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
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
