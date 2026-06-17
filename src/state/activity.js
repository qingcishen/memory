// L3 · 生活模拟 (见 docs/appearance-life-design.md 第三部分 §4)。
//
// 给她"自己的一天": 一张作息+活动模板, 由【时间 + 可重现随机】推出此刻在做什么。
// 不是真模拟, 只产出会外化成一句话的活动文本("刚健身完""在追那个剧"),
// 既给回复添生活气, 又是主动性的燃料(忙完想起你)。
//
// 纯逻辑、无 IO、可重现: 同一 (userId, companionId, 日期, 小时) → 同一活动, 不会一句话一个样。

const DAY_MS = 24 * 60 * 60 * 1000;

// "她"的作息按 Asia/Shanghai(北京时间) 走, 与 buildTimePrompt 给模型的"当前真实时间"一致。
// 该时区全年 UTC+8 无 DST, 用固定偏移而非服务器本地时区, 避免服务器 TZ != Asia/Shanghai 时
// "当前真实时间"和"她这会儿在干什么/是否在睡觉/算不算熬夜"各算各的、互相矛盾。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把任意时刻转成"上海挂钟时间"; 用 getUTC* 读取该 Date 即为北京时间的年/月/日/时/分。 */
export function shanghaiWallClock(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return new Date(ms + SHANGHAI_OFFSET_MS);
}

// 24 小时作息: 每个小时段一个候选活动池, 由可重现随机选一个。
// 段按 [startHour, endHour) 半开区间; 覆盖 0..24。
const ACTIVITY_TEMPLATES = [
  { from: 0, to: 7, sleeping: true, pool: ['睡着了'] },
  { from: 7, to: 9, pool: ['刚睡醒还有点迷糊', '在洗漱准备出门', '随便吃了点早饭'] },
  { from: 9, to: 12, pool: ['在公司忙工作', '在赶一个项目', '在开会', '在学习'] },
  { from: 12, to: 13, pool: ['在吃午饭', '午休眯一会儿'] },
  { from: 13, to: 18, pool: ['在工作', '在处理一堆事情', '抽空摸鱼刷手机', '下午有点犯困'] },
  { from: 18, to: 19, pool: ['在做饭/吃晚饭', '刚吃完晚饭'] },
  { from: 19, to: 22, pool: ['在追剧', '在看书', '刚健身完, 有点累但很爽', '窝在沙发上刷手机', '和朋友聊了会儿天'] },
  { from: 22, to: 24, pool: ['在洗漱准备睡觉', '躺床上玩手机舍不得睡', '困了, 准备睡了'] },
];

/** 找当前小时所属的作息段。 */
function segmentForHour(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  return ACTIVITY_TEMPLATES.find((s) => h >= s.from && h < s.to) ?? ACTIVITY_TEMPLATES[0];
}

/**
 * 此刻在做什么。可重现: 同一 (userId|companionId|日期, 小时) → 同一活动。
 * @param now 时间戳 (ms)
 * @param opts { userId, companionId, sickUntil } —— sickUntil 未到则覆盖为"生病休息"
 * @returns string 活动文本
 */
export function currentActivity(now = Date.now(), opts = {}) {
  // 生病优先: 病中不按正常作息, 一律休息
  if (opts.sickUntil && new Date(opts.sickUntil).getTime() > now) {
    return '生病了, 躺着休息';
  }
  const hour = shanghaiWallClock(now).getUTCHours();
  const seg = segmentForHour(hour);
  if (seg.pool.length === 1) return seg.pool[0];
  // 种子混入 userId/companionId/日期/小时: 同一小时稳定, 跨小时可变
  const seed = hashString(`${opts.userId ?? ''}|${opts.companionId ?? 'default'}|${dateKey(now)}|${hour}`);
  return pickSeeded(seg.pool, seed);
}

/** 当前是否在睡眠时段 (深夜)。 */
export function isSleeping(now = Date.now()) {
  return segmentForHour(shanghaiWallClock(now).getUTCHours()).sleeping === true;
}

/** "HH:MM" → 当天分钟数; 失败返回 null。 */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分钟 cur 是否落在 [from, to) 内 (支持跨午夜, 如 00:30 睡到次日 08:00 写成 0:30-8:00 不跨; 23:00-7:00 跨)。 */
export function minutesInRange(cur, from, to) {
  if (from == null || to == null) return false;
  if (from <= to) return cur >= from && cur < to;
  return cur >= from || cur < to; // 跨午夜
}

/**
 * 用【角色专属作息】(companions/*.json 的 life.schedule_template + sleep) 生成 activityFn。
 * 命中日程段就用该段活动 (段内多个用 "/" 分隔时按种子可重现挑一个); 落在睡眠区间则睡觉;
 * 都没命中时回退到通用 currentActivity。生病优先休息。
 * @param life { schedule:[{from,to,activity}], sleep:"HH:MM-HH:MM" }
 * @returns (now, opts) => string
 */
export function makeScheduleActivityFn(life = {}) {
  const schedule = (life.schedule ?? life.schedule_template ?? [])
    .map((s) => ({ from: parseHHMM(s.from), to: parseHHMM(s.to), activity: String(s.activity ?? '') }))
    .filter((s) => s.from != null && s.to != null && s.activity);
  const sleepParts = String(life.sleep ?? '').split('-');
  const sleepFrom = parseHHMM(sleepParts[0]);
  const sleepTo = parseHHMM(sleepParts[1]);

  return function scheduleActivity(now = Date.now(), opts = {}) {
    if (opts.sickUntil && new Date(opts.sickUntil).getTime() > now) return '生病了, 躺着休息';
    const wall = shanghaiWallClock(now);
    const hour = wall.getUTCHours();
    const cur = hour * 60 + wall.getUTCMinutes();
    if (minutesInRange(cur, sleepFrom, sleepTo)) return '睡着了';
    const slot = schedule.find((s) => minutesInRange(cur, s.from, s.to));
    if (slot) {
      const options = slot.activity.split('/').map((x) => x.trim()).filter(Boolean);
      if (options.length <= 1) return slot.activity;
      const seed = hashString(`${opts.userId ?? ''}|${opts.companionId ?? 'default'}|${dateKey(now)}|${hour}`);
      return pickSeeded(options, seed);
    }
    return currentActivity(now, opts); // 日程没覆盖到的时段走通用模板
  };
}

// ---- helpers (纯, 可重现随机) ----

/** YYYY-MM-DD, 按 Asia/Shanghai 挂钟日期 (接收时间戳或 Date, 不依赖服务器本地时区)。 */
export function dateKey(now = Date.now()) {
  const d = shanghaiWallClock(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 字符串 → 32 位无符号整数 (FNV-1a 变体)。 */
export function hashString(str = '') {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: 由种子产出 [0,1) 可重现随机。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用种子从数组里可重现地选一个。 */
export function pickSeeded(arr, seed) {
  if (!arr || arr.length === 0) return null;
  const r = mulberry32(seed)();
  return arr[Math.floor(r * arr.length) % arr.length];
}

/** "HH:MM-HH:MM" → {from,to}(分钟, 供 minutesInRange); 解析失败返回 null。 */
export function parseSleepWindow(sleep) {
  const parts = String(sleep ?? '').split('-');
  const from = parseHHMM(parts[0]);
  const to = parseHHMM(parts[1]);
  return from != null && to != null ? { from, to } : null;
}

export { ACTIVITY_TEMPLATES, DAY_MS };
