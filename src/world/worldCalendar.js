// W-4 · 中国节日/日历意识（纯函数，无 IO）。
//
// 这里维护“节日当天”而非每年国务院公布的调休安排；周末调班属于会变化的
// 外部数据，不能用静态表冒充。固定法定节日 + 2025-2030 阴历节日足以支撑
// 角色的节日语境，调用方仍可把用户自己的 events 一并传入。

const DAY = 24 * 60 * 60 * 1000;

const FIXED_FESTIVALS = Object.freeze([
  { mmdd: '01-01', label: '元旦', publicHoliday: true },
  { mmdd: '05-01', label: '劳动节', publicHoliday: true },
  { mmdd: '10-01', label: '国庆节', publicHoliday: true },
]);

const YEARLY_FESTIVALS = Object.freeze({
  2025: [
    { date: '2025-01-29', label: '春节', publicHoliday: true },
    { date: '2025-04-04', label: '清明节', publicHoliday: true },
    { date: '2025-05-31', label: '端午节', publicHoliday: true },
    { date: '2025-08-29', label: '七夕', publicHoliday: false },
    { date: '2025-10-06', label: '中秋节', publicHoliday: true },
  ],
  2026: [
    { date: '2026-02-17', label: '春节', publicHoliday: true },
    { date: '2026-04-05', label: '清明节', publicHoliday: true },
    { date: '2026-06-19', label: '端午节', publicHoliday: true },
    { date: '2026-08-19', label: '七夕', publicHoliday: false },
    { date: '2026-09-25', label: '中秋节', publicHoliday: true },
  ],
  2027: [
    { date: '2027-02-06', label: '春节', publicHoliday: true },
    { date: '2027-04-05', label: '清明节', publicHoliday: true },
    { date: '2027-06-09', label: '端午节', publicHoliday: true },
    { date: '2027-08-08', label: '七夕', publicHoliday: false },
    { date: '2027-09-15', label: '中秋节', publicHoliday: true },
  ],
  2028: [
    { date: '2028-01-26', label: '春节', publicHoliday: true },
    { date: '2028-04-04', label: '清明节', publicHoliday: true },
    { date: '2028-05-28', label: '端午节', publicHoliday: true },
    { date: '2028-08-26', label: '七夕', publicHoliday: false },
    { date: '2028-10-03', label: '中秋节', publicHoliday: true },
  ],
  2029: [
    { date: '2029-02-13', label: '春节', publicHoliday: true },
    { date: '2029-04-04', label: '清明节', publicHoliday: true },
    { date: '2029-06-16', label: '端午节', publicHoliday: true },
    { date: '2029-08-16', label: '七夕', publicHoliday: false },
    { date: '2029-09-22', label: '中秋节', publicHoliday: true },
  ],
  2030: [
    { date: '2030-02-02', label: '春节', publicHoliday: true },
    { date: '2030-04-05', label: '清明节', publicHoliday: true },
    { date: '2030-06-05', label: '端午节', publicHoliday: true },
    { date: '2030-08-05', label: '七夕', publicHoliday: false },
    { date: '2030-09-12', label: '中秋节', publicHoliday: true },
  ],
});

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function localDateKey(value = Date.now(), timezoneOffsetMinutes = 480) {
  const timestamp = timeMs(value);
  if (!Number.isFinite(timestamp)) return null;
  const offset = Number(timezoneOffsetMinutes) || 0;
  const shifted = new Date(timestamp + offset * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function chinaFestivalOn(
  value = Date.now(),
  { timezoneOffsetMinutes = 480 } = {},
) {
  const date = localDateKey(value, timezoneOffsetMinutes);
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  const mmdd = date.slice(5);
  return (
    (YEARLY_FESTIVALS[year] ?? []).find((festival) => festival.date === date) ??
    FIXED_FESTIVALS.find((festival) => festival.mmdd === mmdd) ??
    null
  );
}

/** 节日当天返回 true；不把静态表扩张成尚未公布的调休日。 */
export function isChinaHoliday(value = Date.now(), opts = {}) {
  return chinaFestivalOn(value, opts)?.publicHoliday === true;
}

/**
 * 返回节日前一天 / 当天 / 节后第一天的语境。调休不是静态事实，因此这里只
 * 表达节日距离，不把周末或补班日误报为法定假日。
 */
export function chinaFestivalWindow(
  value = Date.now(),
  { timezoneOffsetMinutes = 480 } = {},
) {
  const timestamp = timeMs(value);
  if (!Number.isFinite(timestamp)) return null;
  const candidates = [
    { offset: 0, relation: 'today' },
    { offset: 1, relation: 'before' },
    { offset: -1, relation: 'after' },
  ];
  for (const candidate of candidates) {
    const festival = chinaFestivalOn(timestamp + candidate.offset * DAY, {
      timezoneOffsetMinutes,
    });
    if (!festival) continue;
    return {
      ...festival,
      relation: candidate.relation,
      daysFromFestival: -candidate.offset,
    };
  }
  return null;
}

/**
 * 把用户事项转成距今天数。无效/已过期事件被过滤，按最近优先。
 */
export function daysToEvent(
  events = [],
  value = Date.now(),
  { timezoneOffsetMinutes = 480, includePast = false } = {},
) {
  const baseKey = localDateKey(value, timezoneOffsetMinutes);
  const base = baseKey ? Date.parse(`${baseKey}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(base)) return [];
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      const date = String(event?.date ?? '').slice(0, 10);
      const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? Date.parse(`${date}T00:00:00.000Z`)
        : NaN;
      if (!Number.isFinite(timestamp)) return null;
      return {
        label: String(event?.label ?? '').slice(0, 80),
        date,
        daysAway: Math.round((timestamp - base) / DAY),
      };
    })
    .filter(
      (event) =>
        event?.label && (includePast || Number(event.daysAway) >= 0),
    )
    .sort((a, b) => a.daysAway - b.daysAway);
}

/** 返回未来 N 天的节日（含今天），供 prompt 使用。 */
export function upcomingHolidays(
  value = Date.now(),
  lookAheadDays = 14,
  { timezoneOffsetMinutes = 480 } = {},
) {
  const base = timeMs(value);
  if (!Number.isFinite(base)) return [];
  const results = [];
  const seen = new Set();
  for (let daysAway = 0; daysAway <= Math.max(0, lookAheadDays); daysAway++) {
    const at = base + daysAway * DAY;
    const festival = chinaFestivalOn(at, { timezoneOffsetMinutes });
    const date = localDateKey(at, timezoneOffsetMinutes);
    if (!festival || !date || seen.has(date)) continue;
    seen.add(date);
    results.push({
      label: festival.label,
      date,
      daysAway,
      publicHoliday: festival.publicHoliday,
    });
  }
  return results;
}

export function worldCalendarContext(
  value = Date.now(),
  events = [],
  { timezoneOffsetMinutes = 480, lookAheadDays = 14 } = {},
) {
  const timestamp = timeMs(value);
  if (!Number.isFinite(timestamp)) {
    return { date: null, weekday: null, holiday: null, events: [] };
  }
  const shifted = new Date(timestamp + timezoneOffsetMinutes * 60 * 1000);
  return {
    date: localDateKey(timestamp, timezoneOffsetMinutes),
    weekday: WEEKDAYS[shifted.getUTCDay()],
    holiday: chinaFestivalOn(timestamp, { timezoneOffsetMinutes }),
    holidayWindow: chinaFestivalWindow(timestamp, { timezoneOffsetMinutes }),
    upcomingHolidays: upcomingHolidays(timestamp, lookAheadDays, {
      timezoneOffsetMinutes,
    }),
    events: daysToEvent(events, timestamp, { timezoneOffsetMinutes }),
  };
}

function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value == null || value === '') return NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}
