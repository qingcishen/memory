/**
 * E-4 · Seven-day emotional arc.
 *
 * The CEE persists a compact projection of emotionJournal events so heartbeat
 * can refresh the rolling window even when no Orchestrator instance is alive.
 * Public prompt/state consumers only need weekly_distribution.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ARC_EVENTS = 100;

export const EMOTION_ARC_WINDOW_MS = 7 * DAY_MS;
export const DEFAULT_WEEKLY_DISTRIBUTION = Object.freeze({
  labels: Object.freeze({}),
  dominant: '平静',
  trend: 'stable',
});

const LABEL_VALENCE = Object.freeze({
  平静: 0,
  开心: 0.8,
  委屈: -0.65,
  吃醋: -0.35,
  生气: -0.85,
  失落: -0.7,
  撒娇: 0.5,
  心疼: -0.15,
  期待: 0.65,
  担心: -0.45,
  害羞: 0.3,
  暧昧: 0.4,
  感动: 0.75,
  无聊: -0.3,
  骄傲: 0.7,
  烦躁: -0.6,
});

export function normalizeWeeklyDistribution(raw = {}) {
  const labels = {};
  const source =
    raw?.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)
      ? raw.labels
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw).filter(
              ([key]) => !['dominant', 'trend'].includes(key),
            ),
          )
        : {};
  for (const [label, value] of Object.entries(source).slice(0, 20)) {
    const count = Math.max(0, Math.round(Number(value) || 0));
    if (validLabel(label) && count > 0) labels[label] = count;
  }
  const suppliedDominant = String(raw?.dominant ?? '').trim();
  const dominant =
    validLabel(suppliedDominant) && labels[suppliedDominant] > 0
      ? suppliedDominant
      : dominantLabel(labels);
  const trend = ['improving', 'stable', 'declining'].includes(raw?.trend)
    ? raw.trend
    : 'stable';
  return { labels, dominant, trend };
}

export function normalizeEmotionArcJournal(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((event) => normalizeArcEvent(event))
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_ARC_EVENTS);
}

export function appendEmotionArcEvent(journal = [], event = {}) {
  const list = normalizeEmotionArcJournal(journal);
  const row = normalizeArcEvent(event);
  if (!row) return list;
  const last = list[list.length - 1];
  if (
    last &&
    last.label === row.label &&
    Math.abs(last.at - row.at) < 2_000
  ) {
    list[list.length - 1] = {
      ...last,
      ...row,
      intensity: Math.max(last.intensity, row.intensity),
    };
    return list;
  }
  return [...list, row].slice(-MAX_ARC_EVENTS);
}

/**
 * Orchestrator's legacy journal is capped independently. Merge its rolling
 * snapshot with the CEE projection so a busy week is not silently reduced to
 * only the latest legacy page.
 */
export function mergeEmotionArcJournals(...journals) {
  const merged = new Map();
  for (const journal of journals) {
    for (const event of normalizeEmotionArcJournal(journal)) {
      const key = `${event.at}\u0000${event.label}`;
      const previous = merged.get(key);
      merged.set(key, {
        ...previous,
        ...event,
        intensity: Math.max(previous?.intensity ?? 0, event.intensity),
      });
    }
  }
  return [...merged.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_ARC_EVENTS);
}

/**
 * Rebuild the authoritative seven-day projection and return the pruned journal.
 * Events exactly seven days old remain in the window; future/corrupt entries do
 * not influence the current arc.
 */
export function updateEmotionArc(
  journal = [],
  {
    now = Date.now(),
    windowMs = EMOTION_ARC_WINDOW_MS,
    timezoneOffsetMinutes = 0,
  } = {},
) {
  const nowMs = epoch(now);
  const cutoff = nowMs - Math.max(DAY_MS, Number(windowMs) || EMOTION_ARC_WINDOW_MS);
  const events = normalizeEmotionArcJournal(journal).filter(
    (event) => event.at >= cutoff && event.at <= nowMs,
  );
  const labels = {};
  const latestByLabel = {};
  for (const event of events) {
    labels[event.label] = (labels[event.label] ?? 0) + 1;
    latestByLabel[event.label] = Math.max(
      latestByLabel[event.label] ?? 0,
      event.at,
    );
  }
  const dominant = dominantLabel(labels, latestByLabel);
  return {
    journal: events,
    weekly_distribution: {
      labels,
      dominant,
      trend: emotionTrend(events, timezoneOffsetMinutes),
    },
  };
}

export function emotionArcToPrompt(distribution = {}) {
  const arc = normalizeWeeklyDistribution(distribution);
  if (Object.keys(arc.labels).length === 0) return '';
  const trend = {
    improving: '在慢慢向好',
    stable: '整体较平稳',
    declining: '在逐渐走低',
  }[arc.trend];
  return `近七天的情绪弧线整体偏${arc.dominant}，${trend}；只让这种连续性自然影响语气，不要播报统计或情绪标签。`;
}

function normalizeArcEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const label = String(
    event.toLabel ??
      event.label ??
      event.current_emotion ??
      '',
  ).trim();
  const at = epoch(event.at ?? event.created_at ?? event.updated_at, NaN);
  if (!validLabel(label) || !Number.isFinite(at)) return null;
  return {
    at,
    label,
    intensity: clamp01(
      event.intensity ?? event.emotion_intensity ?? 1,
    ),
  };
}

function emotionTrend(events, timezoneOffsetMinutes) {
  if (events.length < 2) return 'stable';
  const offset = (Number(timezoneOffsetMinutes) || 0) * 60_000;
  const days = new Map();
  for (const event of events) {
    const day = Math.floor((event.at + offset) / DAY_MS);
    const row = days.get(day) ?? { weighted: 0, weight: 0 };
    const weight = Math.max(0.2, event.intensity);
    row.weighted += (LABEL_VALENCE[event.label] ?? 0) * weight;
    row.weight += weight;
    days.set(day, row);
  }
  const points = [...days.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, row]) => [day, row.weight ? row.weighted / row.weight : 0]);
  if (points.length < 2) return 'stable';

  const firstDay = points[0][0];
  const xs = points.map(([day]) => day - firstDay);
  const ys = points.map(([, score]) => score);
  const xMean = average(xs);
  const yMean = average(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (denominator === 0) return 'stable';
  const slope =
    xs.reduce(
      (sum, x, index) => sum + (x - xMean) * (ys[index] - yMean),
      0,
    ) / denominator;
  const projectedChange = slope * (xs[xs.length - 1] - xs[0]);
  if (projectedChange > 0.2) return 'improving';
  if (projectedChange < -0.2) return 'declining';
  return 'stable';
}

function dominantLabel(labels, latestByLabel = {}) {
  const entries = Object.entries(labels);
  if (!entries.length) return '平静';
  entries.sort(
    ([labelA, countA], [labelB, countB]) =>
      countB - countA ||
      (latestByLabel[labelB] ?? 0) - (latestByLabel[labelA] ?? 0) ||
      labelA.localeCompare(labelB, 'zh-CN'),
  );
  return entries[0][0];
}

function validLabel(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 16
  );
}

function epoch(value, fallback = Date.now()) {
  const resolved = typeof value === 'function' ? value() : value;
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  const parsed = date.getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
