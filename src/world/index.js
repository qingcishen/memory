// 世界观系统 · 动态世界状态。
//
// 不是写死的设定文档, 而是随对话缓慢演变的背景剧情线(arc) + 氛围基调(atmosphere):
// 平时按当前状态注入 system prompt, 让角色对"我们所处的世界正在发生什么"有连续感;
// 每轮对话后台用 LLM 判断要不要推进 —— 大多数寻常寒暄不推进, 只有对话里出现值得写进
// 背景的进展(换工作/搬家/旅行等)才更新, 避免世界线为一句"在吗"乱跳。
//
// 读取/写入/推进失败都静默降级, 不影响主对话链路 (同 life/emotion 维度的容错约定)。

import { supabase, llm as defaultLlm, LLM_MODEL } from '../config.js';
import { WeatherProvider, simulateWeather } from './weather.js';
import {
  daysToEvent,
  isChinaHoliday,
  localDateKey,
  upcomingHolidays,
  worldCalendarContext,
} from './worldCalendar.js';
import { weatherAffectOverride } from './worldAffectCoupling.js';

export {
  chinaFestivalOn,
  chinaFestivalWindow,
  daysToEvent,
  isChinaHoliday,
  localDateKey,
  upcomingHolidays,
  worldCalendarContext,
} from './worldCalendar.js';
export {
  applyWorldAffectToSnapshot,
  getWorldAffectOverride,
  weatherAffectOverride,
} from './worldAffectCoupling.js';

/**
 * stable_facts: 稳定事实，LLM 不改动，只通过用户配置/对话提取更新。
 * { city?, lat?, lon?, timezone_offset_minutes?, season?,
 *   relationship_stage?, events: [] }
 */
export function defaultStableFacts() {
  return {
    city: null,
    lat: null,
    lon: null,
    timezone_offset_minutes: null,
    season: null,
    relationship_stage: null,
    events: [],
  };
}

export function normalizeStableFacts(raw) {
  if (!raw || typeof raw !== 'object') return defaultStableFacts();
  return {
    city: raw.city ? String(raw.city).slice(0, 40) : null,
    lat: nullableNumber(raw.lat),
    lon: nullableNumber(raw.lon),
    timezone_offset_minutes: nullableNumber(raw.timezone_offset_minutes),
    season: normalizeSeason(raw.season),
    relationship_stage: raw.relationship_stage
      ? String(raw.relationship_stage).slice(0, 40)
      : null,
    events: (Array.isArray(raw.events) ? raw.events : [])
      .map((event) => ({
        label: String(event?.label ?? '').trim().slice(0, 80),
        date: /^\d{4}-\d{2}-\d{2}/.test(String(event?.date ?? ''))
          ? String(event.date).slice(0, 10)
          : null,
      }))
      .filter((event) => event.label)
      .slice(0, 5),
  };
}

export function defaultWorldState() {
  return {
    arc: '',
    atmosphere: '',
    last_event: '',
    location: null,
    timezone_offset: null,
    season: null,
    weather: null,
    events: [],
    stable_facts: defaultStableFacts(),
    updated_at: null,
  };
}

/** 把数据库中的兼容结构映射成 W-1 顶层结构，同时保留 stable_facts 真相源。 */
export function materializeWorldState(raw = null, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const location = typeof source.location === 'object'
    ? source.location?.city
    : source.location;
  const stableFacts = normalizeStableFacts({
    ...(source.stable_facts ?? {}),
    city: source.stable_facts?.city ?? location,
    timezone_offset_minutes:
      source.stable_facts?.timezone_offset_minutes ?? source.timezone_offset,
    season: source.stable_facts?.season ?? source.season,
    relationship_stage:
      source.stable_facts?.relationship_stage ?? source.relationship_stage,
    events:
      source.stable_facts?.events?.length
        ? source.stable_facts.events
        : source.events,
  });
  stableFacts.events = mergeWorldEvents(
    [],
    stableFacts.events,
    now,
    stableFacts.timezone_offset_minutes ?? 480,
  );
  return {
    ...defaultWorldState(),
    arc: String(source.arc ?? ''),
    atmosphere: String(source.atmosphere ?? ''),
    last_event: String(source.last_event ?? ''),
    location: stableFacts.city,
    timezone_offset: stableFacts.timezone_offset_minutes,
    season: stableFacts.season ?? inferSeason(now),
    weather:
      source.weather && typeof source.weather === 'object'
        ? { ...source.weather }
        : null,
    events: stableFacts.events,
    stable_facts: stableFacts,
    updated_at: source.updated_at ?? null,
  };
}

export async function readWorldState(userId, companionId = 'default') {
  if (!userId) return defaultWorldState();
  let { data, error } = await supabase
    .from('world_state')
    .select('arc, atmosphere, last_event, stable_facts, updated_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .maybeSingle();
  // 旧部署若还没跑 stable_facts migration，至少保住原有动态世界线。
  if (error) {
    const legacy = await supabase
      .from('world_state')
      .select('arc, atmosphere, last_event, updated_at')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .maybeSingle();
    data = legacy.data;
    error = legacy.error;
  }
  if (error || !data) return defaultWorldState();
  return materializeWorldState(data);
}

export async function writeWorldState(userId, companionId = 'default', state) {
  if (!userId) throw new Error('writeWorldState 需要 userId');
  const row = {
    user_id: userId,
    companion_id: companionId,
    arc: state?.arc ?? '',
    atmosphere: state?.atmosphere ?? '',
    last_event: state?.last_event ?? '',
    stable_facts: materializeWorldState(state).stable_facts,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('world_state').upsert(row, { onConflict: 'user_id,companion_id' }).select().single();
  if (error) throw error;
  return materializeWorldState(data ?? row);
}

/** 世界状态 -> 注入用的一段话; 全空 (新用户/世界线还没形成) 返回空串。纯函数。 */
export function toWorldPrompt(state, opts = {}) {
  if (!state) return '';
  const parts = [];
  const resolved = materializeWorldState(state, opts.now ?? Date.now());
  const sf = resolved.stable_facts;
  if (sf.city) parts.push(`所在城市: ${sf.city}`);
  const promptSeason = sf.season ?? normalizeSeason(state.season);
  if (promptSeason) parts.push(`当前季节: ${seasonLabel(promptSeason)}`);

  if (opts.includeCalendar === true) {
    const now = opts.now ?? Date.now();
    const timezoneOffsetMinutes =
      sf.timezone_offset_minutes ??
      opts.timezoneOffsetMinutes ??
      480;
    const calendar = worldCalendarContext(now, sf.events, {
      timezoneOffsetMinutes,
      lookAheadDays: opts.lookAheadDays ?? 14,
    });
    if (calendar.date && calendar.weekday) {
      parts.push(`今天是 ${calendar.date}（${calendar.weekday}）`);
    }
    const festivalWindow = calendar.holidayWindow;
    if (festivalWindow?.relation === 'today') {
      parts.push(`今天是${festivalWindow.label}`);
    } else if (festivalWindow?.relation === 'before') {
      parts.push(`明天是${festivalWindow.label}`);
    } else if (festivalWindow?.relation === 'after') {
      parts.push(`昨天是${festivalWindow.label}，节日余韵还在`);
    }
    const upcoming = (calendar.upcomingHolidays ?? [])
      .filter((holiday) => holiday.daysAway > 1)
      .slice(0, 2);
    if (upcoming.length) {
      parts.push(
        `近期节日: ${upcoming
          .map((holiday) => `${holiday.label}还有${holiday.daysAway}天`)
          .join('、')}`,
      );
    }
    if (calendar.events?.length) {
      parts.push(
        `近期事项: ${calendar.events
          .slice(0, 5)
          .map((event) =>
            event.daysAway === 0
              ? `${event.label}就在今天`
              : `${event.label}还有${event.daysAway}天`,
          )
          .join('、')}`,
      );
    }
  } else if (sf.events?.length) {
    const upcomingStr = sf.events
      .map((event) =>
        event.date ? `${event.label}（${event.date}）` : event.label,
      )
      .join('、');
    parts.push(`近期事项: ${upcomingStr}`);
  }
  if (opts.weatherLine) parts.push(opts.weatherLine);
  if (resolved.atmosphere.trim()) {
    parts.push(`当前世界氛围: ${resolved.atmosphere.trim()}`);
  }
  if (resolved.arc.trim()) parts.push(`背景剧情: ${resolved.arc.trim()}`);
  if (resolved.last_event.trim()) {
    parts.push(`最近的进展: ${resolved.last_event.trim()}`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('\n')}\n结合这些背景自然对话, 别生硬复述设定。`;
}

/**
 * 兼容旧调用方的标量 API；新代码使用 getWorldAffectOverride 同时获得
 * valence/arousal 与节日来源。
 */
export function weatherToValenceDelta(weatherContext = null) {
  return weatherAffectOverride(weatherContext).valence;
}

/** 组装喂给"要不要推进世界线"判断的输入; 纯函数, 可单测。 */
export function composeEvolveInput(state, turns = []) {
  const convo = (turns ?? []).map((t) => `${t.role === 'user' ? '对方' : '她'}: ${t.content}`).join('\n');
  const s = state ?? defaultWorldState();
  return [
    `当前世界状态: 氛围=${s.atmosphere || '(无)'}; 背景剧情=${s.arc || '(无)'}; 最近进展=${s.last_event || '(无)'}`,
    `最近对话:\n${convo || '(无)'}`,
  ].join('\n\n');
}

// 常见城市经纬度预设，供没有显式坐标时按城市名获取天气。
const CITY_COORDS = {
  '北京': { lat: 39.9042, lon: 116.4074 },
  '上海': { lat: 31.2304, lon: 121.4737 },
  '深圳': { lat: 22.5431, lon: 114.0579 },
  '广州': { lat: 23.1291, lon: 113.2644 },
  '武汉': { lat: 30.5928, lon: 114.3055 },
  '成都': { lat: 30.5728, lon: 104.0668 },
  '杭州': { lat: 30.2741, lon: 120.1551 },
  '南京': { lat: 32.0603, lon: 118.7969 },
  '重庆': { lat: 29.5630, lon: 106.5516 },
  '西安': { lat: 34.3416, lon: 108.9398 },
  '长沙': { lat: 28.2282, lon: 112.9388 },
  '苏州': { lat: 31.2989, lon: 120.5853 },
  '天津': { lat: 39.3434, lon: 117.3616 },
  '郑州': { lat: 34.7473, lon: 113.6249 },
};

const EVOLVE_SYS = `你在帮一个 AI 伴侣维护"世界观状态"——她所处世界的背景剧情与氛围基调, 用来让对话有连续感。
大多数日常寒暄不需要推进世界线, 只有对话里出现了值得写进背景的进展(换工作/搬家/旅行/两人关系之外的生活事件等)才更新。
如果这一轮没有这样的进展, 把 changed 设为 false。严格输出 JSON: {"changed": true/false, "arc": "...", "atmosphere": "...", "last_event": "..."}。`;

export class WorldDimension {
  constructor({
    userId,
    companionId = 'default',
    read = readWorldState,
    write = writeWorldState,
    llmClient = defaultLlm,
    model = LLM_MODEL,
    weatherProvider = null,
    now = () => Date.now(),
  } = {}) {
    this.userId = userId;
    this.companionId = companionId;
    this.read = read;
    this.write = write;
    this.llmClient = llmClient;
    this.model = model;
    this._weatherProvider = weatherProvider;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this._derivedWeatherProvider = null;
    this._derivedWeatherKey = null;
  }

  async current() {
    if (!this.userId) return defaultWorldState();
    // readWorldState 已返回完整结构；注入自定义 read 时保留其对象语义，避免破坏
    // 现有测试/适配器的引用比较。消费点会再做兼容归一化。
    return this.read(this.userId, this.companionId);
  }

  /**
   * W-3 天气：返回 { temperature, condition, humidity, tempC, desc }。
   * 优先真实观测；没有坐标、请求失败且无旧缓存时按城市/季节确定性模拟。
   */
  async weather() {
    const state = await this.current().catch(() => defaultWorldState());
    const sf = normalizeStableFacts(state.stable_facts);
    const city = sf.city ?? state.location ?? this._weatherProvider?.place ?? null;
    let provider = this._weatherProvider;
    if (!provider && city) {
      const coords =
        sf.lat != null && sf.lon != null
          ? { lat: sf.lat, lon: sf.lon }
          : CITY_COORDS[city] ?? null;
      if (coords) {
        const key = `${city}:${coords.lat}:${coords.lon}`;
        if (!this._derivedWeatherProvider || this._derivedWeatherKey !== key) {
          this._derivedWeatherProvider = new WeatherProvider({
            place: city,
            ...coords,
            now: this.now,
          });
          this._derivedWeatherKey = key;
        }
        provider = this._derivedWeatherProvider;
      }
    }
    if (provider?.fetch) {
      try {
        const raw = await provider.fetch();
        const normalized = normalizeWeather(raw);
        if (normalized) return normalized;
      } catch {
        // 无旧缓存时进入季节模拟。
      }
    }
    if (!city) return null;
    return normalizeWeather(
      simulateWeather(city, sf.season ?? state.season, this.now()),
    );
  }

  toPrompt(state, opts = {}) {
    return toWorldPrompt(state, {
      ...opts,
      includeCalendar: opts.includeCalendar ?? true,
      now: opts.now ?? this.now(),
    });
  }

  /**
   * W-1 更新稳定事实（不经 LLM，直接写库）。
   * 用于用户告知城市、配置坐标、或对话中抽取到新 event 时。
   */
  async updateStableFacts(patch = {}) {
    if (!this.userId) return null;
    const state = await this.current().catch(() => defaultWorldState());
    const merged = normalizeStableFacts({ ...state.stable_facts, ...patch });
    const next = materializeWorldState({ ...state, stable_facts: merged }, this.now());
    return this.write(this.userId, this.companionId, next).catch(() => null);
  }

  /**
   * 后台判断这一轮要不要推进世界线; 无 userId/无对话内容时跳过。
   * 任何失败(LLM 报错/JSON 解析失败/写库失败)都静默返回 null, 不影响主对话链路。
   */
  async evolve(turns = []) {
    if (!this.userId || !turns?.length) return null;
    let state = await this.current().catch(() => defaultWorldState());
    const extracted = extractStableFactsFromTurns(turns, {
      now: this.now(),
      timezoneOffsetMinutes:
        state.stable_facts?.timezone_offset_minutes ?? 480,
    });
    if (Object.keys(extracted).length) {
      const existingEvents = state.stable_facts?.events ?? [];
      const mergedEvents = mergeWorldEvents(
        extracted.events ?? [],
        existingEvents,
        this.now(),
        state.stable_facts?.timezone_offset_minutes ?? 480,
      );
      const stableFacts = normalizeStableFacts({
        ...state.stable_facts,
        ...extracted,
        events: mergedEvents,
      });
      const stableNext = materializeWorldState(
        { ...state, stable_facts: stableFacts },
        this.now(),
      );
      const written = await this.write(
        this.userId,
        this.companionId,
        stableNext,
      ).catch(() => null);
      state = written
        ? materializeWorldState(written, this.now())
        : stableNext;
    }
    let res;
    try {
      res = await this.llmClient.chat.completions.create({
        model: this.model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EVOLVE_SYS },
          { role: 'user', content: composeEvolveInput(state, turns) },
        ],
      });
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.choices[0].message.content);
    } catch {
      return null;
    }
    if (!parsed?.changed) return state;
    // LLM 等待期间系统配置可能更新了城市/事项；提交前再读一次，只取最新稳定事实。
    const latest = await this.current().catch(() => state);
    const next = {
      arc: safeDynamicText(parsed.arc ?? state.arc, 2000),
      atmosphere: safeDynamicText(
        parsed.atmosphere ?? state.atmosphere,
        600,
      ),
      last_event: safeDynamicText(parsed.last_event ?? state.last_event, 1000),
      // W-2: evolve 不改 stable_facts，保持 LLM 不可覆盖的稳定事实。
      stable_facts: latest.stable_facts,
    };
    try {
      return await this.write(this.userId, this.companionId, next);
    } catch {
      return null;
    }
  }
}

/** 从用户原话抽取不需要 LLM 自由改写的城市与未来事项。 */
export function extractStableFactsFromTurns(
  turns = [],
  { now = Date.now(), timezoneOffsetMinutes = 480 } = {},
) {
  const messages = (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn?.role === 'user')
    .map((turn) => String(turn.content ?? '').trim())
    .filter(Boolean);
  if (!messages.length) return {};

  let city = null;
  for (const text of [...messages].reverse()) {
    city = Object.keys(CITY_COORDS).find((candidate) => {
      const escaped = escapeRegExp(candidate);
      return new RegExp(
        `(?:我(?:现在)?(?:住在|在|搬到|定居在|工作在)|所在城市是)\\s*${escaped}|${escaped}.{0,5}(?:生活|定居|工作)`,
      ).test(text);
    }) ?? null;
    if (city) break;
  }

  const events = [];
  for (const text of messages) {
    const eventDate = futureDateFromText(text, now, timezoneOffsetMinutes);
    if (!eventDate) continue;
    const labels = [
      ...text.matchAll(
        /面试|旅行|出差|约会|考试|开会|手术|复诊|生日|婚礼|发布会|演出|搬家/gu,
      ),
    ].map((match) => match[0]);
    for (const label of [...new Set(labels)]) {
      events.push({ label, date: eventDate });
    }
  }

  return {
    ...(city ? { city } : {}),
    ...(events.length ? { events } : {}),
  };
}

/** 只保留未过期、有效且不重复的最近五个事项。 */
export function mergeWorldEvents(
  incoming = [],
  existing = [],
  now = Date.now(),
  timezoneOffsetMinutes = 480,
) {
  const normalized = [...(incoming ?? []), ...(existing ?? [])]
    .map((event) => ({
      label: String(event?.label ?? '').trim().slice(0, 80),
      date: String(event?.date ?? '').slice(0, 10),
    }))
    .filter(
      (event) =>
        event.label && /^\d{4}-\d{2}-\d{2}$/.test(event.date),
    );
  const future = daysToEvent(normalized, now, {
    timezoneOffsetMinutes,
  });
  const seen = new Set();
  return future
    .filter((event) => {
      const key = `${event.label}:${event.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map(({ label, date }) => ({ label, date }));
}

export function inferSeason(value = Date.now()) {
  const month = new Date(value).getUTCMonth() + 1;
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function futureDateFromText(text, now, timezoneOffsetMinutes) {
  const value = String(text ?? '');
  const iso = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return iso;
  const relativeDays =
    /后天/.test(value)
      ? 2
      : /明天/.test(value)
        ? 1
        : /下周/.test(value)
          ? 7
          : /今天/.test(value)
            ? 0
            : null;
  const baseKey = localDateKey(now, timezoneOffsetMinutes);
  const base = baseKey ? Date.parse(`${baseKey}T00:00:00.000Z`) : NaN;
  if (relativeDays != null && Number.isFinite(base)) {
    return new Date(base + relativeDays * 86400000)
      .toISOString()
      .slice(0, 10);
  }
  const monthDay = value.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (!monthDay || !Number.isFinite(base)) return null;
  const month = Number(monthDay[1]);
  const day = Number(monthDay[2]);
  const currentYear = Number(baseKey.slice(0, 4));
  const candidate = Date.UTC(currentYear, month - 1, day);
  const timestamp = candidate < base
    ? Date.UTC(currentYear + 1, month - 1, day)
    : candidate;
  const date = new Date(timestamp);
  if (
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizeWeather(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const temperature = Number(raw.temperature ?? raw.tempC);
  if (!Number.isFinite(temperature)) return null;
  const condition = String(raw.condition ?? raw.desc ?? '天气未知');
  const humidity = Number(raw.humidity);
  return {
    temperature,
    condition,
    humidity: Number.isFinite(humidity) ? humidity : null,
    tempC: temperature,
    desc: condition,
    ...(raw.simulated ? { simulated: true } : {}),
  };
}

function normalizeSeason(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return {
    spring: 'spring',
    春: 'spring',
    春季: 'spring',
    summer: 'summer',
    夏: 'summer',
    夏季: 'summer',
    autumn: 'autumn',
    fall: 'autumn',
    秋: 'autumn',
    秋季: 'autumn',
    winter: 'winter',
    冬: 'winter',
    冬季: 'winter',
  }[key] ?? null;
}

function seasonLabel(season) {
  return {
    spring: '春季',
    summer: '夏季',
    autumn: '秋季',
    winter: '冬季',
  }[season] ?? season;
}

function nullableNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeDynamicText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
