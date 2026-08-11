// W-5 · 世界状态 → 本轮情绪基线（纯函数）。

import {
  chinaFestivalWindow,
  isChinaHoliday,
} from './worldCalendar.js';

/** 恶劣天气统一施加一次 -0.05/-0.1；晴天不额外抬高，保证差值可解释。 */
export function weatherAffectOverride(weather = null) {
  if (!weather || typeof weather !== 'object') {
    return { valence: 0, arousal: 0 };
  }
  const temperature = Number(weather.temperature ?? weather.tempC);
  const condition = String(weather.condition ?? weather.desc ?? '').toLowerCase();
  const adverse =
    (Number.isFinite(temperature) && temperature < 12) ||
    /rain|storm|snow|雨|暴风|雷|雪/.test(condition);
  return adverse
    ? { valence: -0.05, arousal: -0.1 }
    : { valence: 0, arousal: 0 };
}

export function getWorldAffectOverride(
  worldState = null,
  value = Date.now(),
  opts = {},
) {
  const weather = opts.weather ?? worldState?.weather ?? null;
  const base = weatherAffectOverride(weather);
  const timezoneOffsetMinutes =
    opts.timezoneOffsetMinutes ??
    worldState?.stable_facts?.timezone_offset_minutes ??
    worldState?.timezone_offset ??
    480;
  const holiday =
    opts.holiday ??
    isChinaHoliday(value, {
      timezoneOffsetMinutes,
    });
  const holidayWindowRaw =
    opts.holidayWindow ??
    chinaFestivalWindow(value, { timezoneOffsetMinutes });
  const holidayWindow =
    holidayWindowRaw?.publicHoliday === true ? holidayWindowRaw : null;
  const holidayRelation = holiday
    ? 'today'
    : holidayWindow?.relation ?? null;
  const holidayValence =
    holidayRelation === 'today'
      ? 0.05
      : holidayRelation === 'before'
        ? 0.025
        : holidayRelation === 'after'
          ? 0.015
          : 0;
  return {
    valence: clamp(base.valence + holidayValence, -0.1, 0.1),
    arousal: clamp(base.arousal, -0.1, 0.1),
    reasons: [
      ...(base.valence < 0 ? ['adverse_weather'] : []),
      ...(holidayRelation ? [`holiday_${holidayRelation}`] : []),
    ],
    holidayRelation,
  };
}

/**
 * 把世界影响叠到“本轮展示快照”，不修改持久情绪状态。这样连续多轮雨天不会
 * 每轮再扣一次造成漂移，天气好转后基线也会自然恢复。
 */
export function applyWorldAffectToSnapshot(snapshot = null, override = null) {
  if (!snapshot || !override) return snapshot;
  const valenceDelta = Number(override.valence) || 0;
  const arousalDelta = Number(override.arousal) || 0;
  if (valenceDelta === 0 && arousalDelta === 0) return snapshot;

  const emotion = snapshot.emotion ?? {};
  const mood = snapshot.mood ?? null;
  const emotionArousal = firstFinite(
    emotion.arousal,
    mood?.arousal,
    0.5,
  );
  return {
    ...snapshot,
    emotion: {
      ...emotion,
      valence: clamp(firstFinite(emotion.valence, mood?.valence, 0) + valenceDelta, -1, 1),
      arousal: clamp(emotionArousal + arousalDelta, 0, 1),
    },
    ...(mood
      ? {
          mood: {
            ...mood,
            valence: clamp(firstFinite(mood.valence, emotion.valence, 0) + valenceDelta, -1, 1),
            arousal: clamp(firstFinite(mood.arousal, emotion.arousal, 0.5) + arousalDelta, 0, 1),
          },
        }
      : {}),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function firstFinite(...values) {
  return values.map(Number).find(Number.isFinite) ?? 0;
}
