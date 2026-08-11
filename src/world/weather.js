// 真实世界 · 天气感知。
//
// 让她知道"武汉现在下没下雨、冷不冷"——真人张口就知道的事。
// 用 open-meteo (无需 key) 按经纬度拉当前天气, 进程内缓存 (天气变化慢, 不必每条消息都请求);
// 拉不到就降级返回空串, 绝不影响回复。

const HOUR = 60 * 60 * 1000;

// WMO weather_code → 中文天气 (open-meteo current.weather_code)。
const WMO_ZH = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

/** WMO code → 中文描述 (未知码给"天气未知")。纯函数。 */
export function weatherCodeToZh(code) {
  return WMO_ZH[Number(code)] ?? '天气未知';
}

/** 把天气数据拼成一句注入用的话; 空数据返回空串。纯函数。 */
export function buildWeatherLine(weather, place = '武汉') {
  if (!weather || typeof weather.tempC !== 'number') return '';
  const humidity = Number(weather.humidity);
  const humidityText = Number.isFinite(humidity)
    ? `，湿度 ${Math.round(humidity)}%`
    : '';
  return `${place}现在${weather.desc}, 气温 ${Math.round(weather.tempC)}°C${humidityText}。`;
}

export class WeatherProvider {
  /** @param {object} opts { place:'武汉', lat, lon, ttlMs, fetchImpl } */
  constructor({ place = '武汉', lat = 30.5928, lon = 114.3055, ttlMs = HOUR, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.place = place;
    this.lat = lat;
    this.lon = lon;
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this._cache = null; // { at, weather }
  }

  /** 拉当前天气 (带 1h 缓存), 返回 { tempC, code, desc, humidity } 或 null。 */
  async fetch() {
    const now = this.now();
    if (this._cache && now - this._cache.at < this.ttlMs) {
      return this._cache.weather;
    }
    if (typeof this.fetchImpl !== 'function') return this._cache?.weather ?? null;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia%2FShanghai`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const data = await res.json();
      const cur = data?.current ?? {};
      const tempC = Number(cur.temperature_2m);
      const code = Number(cur.weather_code);
      const humidity = Number(cur.relative_humidity_2m);
      if (!Number.isFinite(tempC)) return this._cache?.weather ?? null;
      const weather = {
        tempC,
        code,
        desc: weatherCodeToZh(code),
        ...(Number.isFinite(humidity) ? { humidity } : {}),
      };
      this._cache = { at: now, weather };
      return weather;
    } catch (error) {
      if (this._cache?.weather) return this._cache.weather;
      throw error;
    }
  }

  /** 返回一句可注入的天气描述 (带缓存); 任何失败都降级为空串, 不抛。 */
  async current() {
    try {
      const weather = await this.fetch();
      return buildWeatherLine(weather, this.place);
    } catch {
      return '';
    }
  }
}

/**
 * 无网络时的季节天气。按“城市 + 本地日期”确定性生成，同一天多次调用一致，
 * 但不同日期仍会自然变化，适合作为外部天气服务的降级而不是伪装成实时观测。
 */
export function simulateWeather(city = '当前城市', season = null, now = Date.now()) {
  const resolvedSeason = normalizeSeason(season) ?? seasonFromMonth(now);
  const dateKey = new Date(now).toISOString().slice(0, 10);
  const seed = stableHash(`${String(city)}|${dateKey}|${resolvedSeason}`);
  const profiles = {
    spring: { base: 18, conditions: ['多云', '晴间多云', '小雨'], humidity: 66 },
    summer: { base: 30, conditions: ['晴', '多云', '阵雨'], humidity: 72 },
    autumn: { base: 21, conditions: ['晴', '多云', '小雨'], humidity: 58 },
    winter: { base: 7, conditions: ['晴', '阴', '小雨'], humidity: 54 },
  };
  const profile = profiles[resolvedSeason] ?? profiles.spring;
  const jitter = (seed % 7) - 3;
  const desc = profile.conditions[Math.floor(seed / 7) % profile.conditions.length];
  const humidity = Math.max(25, Math.min(95, profile.humidity + (Math.floor(seed / 31) % 17) - 8));
  return {
    tempC: profile.base + jitter,
    temperature: profile.base + jitter,
    code: null,
    desc,
    condition: desc,
    humidity,
    simulated: true,
    season: resolvedSeason,
  };
}

/**
 * 函数式入口，便于非 WorldDimension 调用方按城市/坐标获取天气。
 * 城市到坐标的解析由调用方配置，缺坐标时返回季节模拟。
 */
export async function fetchWeather(city, {
  lat = null,
  lon = null,
  season = null,
  now = Date.now(),
  provider = null,
  fetchImpl = globalThis.fetch,
  ttlMs = HOUR,
} = {}) {
  const canFetch = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  const source = provider ?? (canFetch
    ? new WeatherProvider({
        place: city || '当前城市',
        lat: Number(lat),
        lon: Number(lon),
        fetchImpl,
        ttlMs,
      })
    : null);
  if (source?.fetch) {
    try {
      const raw = await source.fetch();
      if (raw) return raw;
    } catch {
      // 下面统一走季节模拟。
    }
  }
  return simulateWeather(city || '当前城市', season, now);
}

function normalizeSeason(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const aliases = {
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
  };
  return aliases[key] ?? null;
}

function seasonFromMonth(now) {
  const month = new Date(now).getUTCMonth() + 1;
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function stableHash(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
