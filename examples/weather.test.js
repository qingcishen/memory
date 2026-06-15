// 真实世界 · 天气 测试。纯逻辑 + 注入假 fetch, 不连网。
import assert from 'node:assert';
import { WeatherProvider, weatherCodeToZh, buildWeatherLine } from '../src/world/weather.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('weatherCodeToZh / buildWeatherLine (纯逻辑)');
{
  ok('0 → 晴', weatherCodeToZh(0) === '晴');
  ok('61 → 小雨', weatherCodeToZh(61) === '小雨');
  ok('95 → 雷阵雨', weatherCodeToZh(95) === '雷阵雨');
  ok('未知码 → 天气未知', weatherCodeToZh(999) === '天气未知');
  ok('拼出一句话', buildWeatherLine({ tempC: 26.4, desc: '多云' }, '武汉') === '武汉现在多云, 气温 26°C。');
  ok('空数据 → 空串', buildWeatherLine(null) === '');
}

console.log('WeatherProvider (注入假 fetch + 缓存 + 降级)');
{
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ current: { temperature_2m: 18, weather_code: 3 } }) };
  };
  let t = 1000;
  const wp = new WeatherProvider({ place: '武汉', fetchImpl: fakeFetch, ttlMs: 1000, now: () => t });
  const a = await wp.current();
  ok('返回天气句', a === '武汉现在阴, 气温 18°C。');
  await wp.current();
  ok('TTL 内不重复请求 (缓存)', calls === 1);
  t += 2000; // 过 TTL
  await wp.current();
  ok('过 TTL 重新请求', calls === 2);

  // 失败降级: 有旧缓存用旧的, 没缓存返回空串
  const failing = new WeatherProvider({ fetchImpl: async () => ({ ok: false, status: 500 }), now: () => 0 });
  ok('拉不到且无缓存 → 空串', (await failing.current()) === '');
  const noFetch = new WeatherProvider({ fetchImpl: null });
  ok('无 fetch → 空串, 不抛', (await noFetch.current()) === '');
}

console.log(`\n天气感知 全部 ${passed} 条断言通过`);
