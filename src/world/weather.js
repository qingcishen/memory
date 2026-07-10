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
  return `${place}现在${weather.desc}, 气温 ${Math.round(weather.tempC)}°C。`;
}

export class WeatherProvider {
  /** @param {object} opts { place:'武汉', lat, lon, ttlMs, fetchImpl } */
  constructor({ place = '武汉', lat = 30.5928, lon = 114.3055, ttlMs = HOUR / 2, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.place = place;
    this.lat = lat;
    this.lon = lon;
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this._cache = null; // { at, weather }
  }

  /** 拉当前天气 (带缓存), 返回 { tempC, code, desc } 或 null。失败/无 fetch 时 null。 */
  async fetch() {
    if (typeof this.fetchImpl !== 'function') return null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}&current=temperature_2m,weather_code&timezone=Asia%2FShanghai`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const data = await res.json();
    const cur = data?.current ?? {};
    const tempC = Number(cur.temperature_2m);
    const code = Number(cur.weather_code);
    if (Number.isNaN(tempC)) return null;
    return { tempC, code, desc: weatherCodeToZh(code) };
  }

  /** 返回一句可注入的天气描述 (带缓存); 任何失败都降级为空串, 不抛。 */
  async current() {
    const now = this.now();
    if (this._cache && now - this._cache.at < this.ttlMs) return buildWeatherLine(this._cache.weather, this.place);
    try {
      const weather = await this.fetch();
      if (weather) this._cache = { at: now, weather };
      return buildWeatherLine(weather, this.place);
    } catch {
      // 拉不到就用旧缓存 (若有), 否则空串
      return this._cache ? buildWeatherLine(this._cache.weather, this.place) : '';
    }
  }
}
