import { describe, expect, it, vi } from 'vitest';
import { toEmotionPrompt } from '../src/emotion.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import {
  defaultStableFacts,
  defaultWorldState,
  extractStableFactsFromTurns,
  materializeWorldState,
  mergeWorldEvents,
  normalizeStableFacts,
  toWorldPrompt,
  WorldDimension,
} from '../src/world/index.js';
import {
  chinaFestivalWindow,
  daysToEvent,
  isChinaHoliday,
  worldCalendarContext,
} from '../src/world/worldCalendar.js';
import {
  applyWorldAffectToSnapshot,
  getWorldAffectOverride,
  weatherAffectOverride,
} from '../src/world/worldAffectCoupling.js';
import {
  WeatherProvider,
  simulateWeather,
} from '../src/world/weather.js';

const NOW = Date.parse('2026-07-29T04:00:00.000Z');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('W-1 structured world facts', () => {
  it('exposes the complete top-level shape and protected stable fields', () => {
    expect(defaultWorldState()).toMatchObject({
      location: null,
      timezone_offset: null,
      season: null,
      weather: null,
      events: [],
      stable_facts: {
        city: null,
        season: null,
        relationship_stage: null,
        events: [],
      },
    });
  });

  it('preserves valid zero coordinates/timezone and rejects invalid numbers', () => {
    expect(
      normalizeStableFacts({
        city: '伦敦',
        lat: 0,
        lon: 0,
        timezone_offset_minutes: 0,
      }),
    ).toMatchObject({
      city: '伦敦',
      lat: 0,
      lon: 0,
      timezone_offset_minutes: 0,
    });
    expect(
      normalizeStableFacts({ lat: 'nope', lon: false }),
    ).toMatchObject({ lat: null, lon: null });
  });

  it('sorts, deduplicates and keeps only five future events', () => {
    const events = mergeWorldEvents(
      [
        { label: '旅行', date: '2026-08-10' },
        { label: '面试', date: '2026-08-01' },
        { label: '面试', date: '2026-08-01' },
        { label: '过期', date: '2026-01-01' },
        { label: '考试', date: '2026-08-03' },
        { label: '约会', date: '2026-08-04' },
        { label: '复诊', date: '2026-08-05' },
        { label: '婚礼', date: '2026-08-06' },
      ],
      [],
      NOW,
    );
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.label)).toEqual([
      '面试',
      '考试',
      '约会',
      '复诊',
      '婚礼',
    ]);
  });

  it('extracts configured-city facts and dated future events from user turns', () => {
    expect(
      extractStableFactsFromTurns(
        [
          { role: 'user', content: '我现在住在上海，下周有面试' },
          { role: 'assistant', content: '记住了' },
          { role: 'user', content: '后天还要复诊' },
        ],
        { now: NOW },
      ),
    ).toEqual({
      city: '上海',
      events: [
        { label: '面试', date: '2026-08-05' },
        { label: '复诊', date: '2026-07-31' },
      ],
    });
  });

  it('materializes top-level aliases from the stable truth source', () => {
    const state = materializeWorldState(
      {
        arc: '准备搬家',
        stable_facts: {
          ...defaultStableFacts(),
          city: '杭州',
          timezone_offset_minutes: 480,
          season: 'summer',
          events: [{ label: '旅行', date: '2026-08-02' }],
        },
      },
      NOW,
    );
    expect(state).toMatchObject({
      location: '杭州',
      timezone_offset: 480,
      season: 'summer',
      events: [{ label: '旅行', date: '2026-08-02' }],
    });
  });
});

describe('W-2 stable/dynamic separation', () => {
  it('ignores malicious stable-fact fields from the LLM for 50 evolutions', async () => {
    let state = materializeWorldState(
      {
        stable_facts: {
          city: '北京',
          season: 'summer',
          relationship_stage: 'committed',
          events: [{ label: '旅行', date: '2026-08-10' }],
        },
      },
      NOW,
    );
    const original = clone(state.stable_facts);
    const dimension = new WorldDimension({
      userId: 'world-stable-50',
      now: () => NOW,
      read: async () => clone(state),
      write: async (_userId, _companionId, next) => {
        state = materializeWorldState(next, NOW);
        return clone(state);
      },
      llmClient: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    changed: true,
                    arc: '动态弧线',
                    atmosphere: '平静',
                    last_event: '推进',
                    stable_facts: { city: '恶意覆盖' },
                    location: '恶意覆盖',
                    season: 'winter',
                  }),
                },
              }],
            }),
          },
        },
      },
    });

    for (let index = 0; index < 50; index++) {
      await dimension.evolve([
        { role: 'user', content: `普通对话第${index}轮` },
      ]);
    }
    expect(state.stable_facts).toEqual(original);
    expect(state.arc).toBe('动态弧线');
  });

  it('re-reads stable facts after the LLM wait so a concurrent setting update survives', async () => {
    let state = materializeWorldState(
      { stable_facts: { city: '北京' } },
      NOW,
    );
    let resolveLLM;
    const dimension = new WorldDimension({
      userId: 'world-concurrent',
      now: () => NOW,
      read: async () => clone(state),
      write: async (_userId, _companionId, next) => {
        state = materializeWorldState(next, NOW);
        return clone(state);
      },
      llmClient: {
        chat: {
          completions: {
            create: () =>
              new Promise((resolve) => {
                resolveLLM = () =>
                  resolve({
                    choices: [{
                      message: {
                        content: JSON.stringify({
                          changed: true,
                          arc: 'LLM 完成',
                        }),
                      },
                    }],
                  });
              }),
          },
        },
      },
    });

    const evolving = dimension.evolve([
      { role: 'user', content: '今天聊点普通的' },
    ]);
    await vi.waitFor(() => expect(resolveLLM).toBeTypeOf('function'));
    await dimension.updateStableFacts({ city: '上海' });
    resolveLLM();
    await evolving;

    expect(state.stable_facts.city).toBe('上海');
    expect(state.arc).toBe('LLM 完成');
  });
});

describe('W-3 weather source, cache and fallback', () => {
  it('caches fetch() itself for one hour and returns humidity', async () => {
    let time = 0;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 23,
          relative_humidity_2m: 67,
          weather_code: 2,
        },
      }),
    }));
    const provider = new WeatherProvider({
      ttlMs: 60 * 60 * 1000,
      now: () => time,
      fetchImpl,
    });
    await provider.fetch();
    time += 59 * 60 * 1000;
    expect(await provider.fetch()).toMatchObject({
      tempC: 23,
      humidity: 67,
      desc: '多云',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time += 60 * 1000;
    await provider.fetch();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns seasonal simulation when a configured city cannot reach the API', async () => {
    const dimension = new WorldDimension({
      userId: 'world-weather-fallback',
      now: () => NOW,
      read: async () =>
        materializeWorldState({
          stable_facts: { city: '上海', season: 'summer' },
        }, NOW),
      weatherProvider: {
        place: '上海',
        fetch: async () => {
          throw new Error('offline');
        },
      },
    });
    expect(await dimension.weather()).toMatchObject({
      condition: expect.any(String),
      temperature: expect.any(Number),
      humidity: expect.any(Number),
      simulated: true,
    });
  });

  it('keeps simulated weather stable for the same city/day', () => {
    expect(simulateWeather('武汉', 'summer', NOW)).toEqual(
      simulateWeather('武汉', 'summer', NOW),
    );
  });
});

describe('W-4 calendar awareness', () => {
  it('distinguishes public holidays from cultural festivals', () => {
    expect(isChinaHoliday('2026-02-17T04:00:00Z')).toBe(true);
    expect(isChinaHoliday('2026-08-19T04:00:00Z')).toBe(false);
    expect(
      chinaFestivalWindow('2026-02-16T04:00:00Z'),
    ).toMatchObject({ label: '春节', relation: 'before' });
    expect(
      chinaFestivalWindow('2026-02-18T04:00:00Z'),
    ).toMatchObject({ label: '春节', relation: 'after' });
  });

  it('calculates event countdowns and filters expired dates', () => {
    expect(
      daysToEvent(
        [
          { label: '面试', date: '2026-08-02' },
          { label: '旧事', date: '2026-01-01' },
        ],
        NOW,
      ),
    ).toEqual([{ label: '面试', date: '2026-08-02', daysAway: 4 }]);
  });

  it('injects weekday, event countdown and festival proximity in production prompt', () => {
    const prompt = toWorldPrompt(
      {
        stable_facts: {
          city: '上海',
          events: [{ label: '面试', date: '2026-02-20' }],
        },
      },
      {
        now: Date.parse('2026-02-16T04:00:00Z'),
        includeCalendar: true,
      },
    );
    expect(prompt).toContain('周一');
    expect(prompt).toContain('明天是春节');
    expect(prompt).toContain('面试还有4天');
    expect(worldCalendarContext(NOW).weekday).toBe('周三');
  });
});

describe('W-5 world affect coupling', () => {
  it('uses exact non-stacking adverse weather deltas and no sunny bonus', () => {
    expect(weatherAffectOverride({ temperature: 25, condition: '晴' })).toEqual({
      valence: 0,
      arousal: 0,
    });
    expect(
      weatherAffectOverride({ temperature: 5, condition: '暴雨夹雪' }),
    ).toEqual({ valence: -0.05, arousal: -0.1 });
  });

  it('adds +0.05 only on a public-holiday day, not Qixi', () => {
    expect(
      getWorldAffectOverride(
        null,
        Date.parse('2026-02-17T04:00:00Z'),
        { weather: { temperature: 25, condition: '晴' } },
      ),
    ).toMatchObject({ valence: 0.05, holidayRelation: 'today' });
    expect(
      getWorldAffectOverride(
        null,
        Date.parse('2026-08-19T04:00:00Z'),
        { weather: { temperature: 25, condition: '晴' } },
      ),
    ).toMatchObject({ valence: 0, holidayRelation: null });
  });

  it('applies the override immutably and makes arousal observable in the prompt', () => {
    const original = {
      emotion: { valence: 0.2, warmth: 0.7 },
      mood: { valence: 0.2, arousal: 0.5 },
    };
    const override = { valence: -0.05, arousal: -0.1 };
    const first = applyWorldAffectToSnapshot(original, override);
    const second = applyWorldAffectToSnapshot(original, override);
    expect(first).toEqual(second);
    expect(original.mood.arousal).toBe(0.5);
    expect(first.emotion.valence).toBeCloseTo(0.15);
    expect(first.emotion.arousal).toBeCloseTo(0.4);
    expect(first.mood.valence).toBeCloseTo(0.15);
    expect(first.mood.arousal).toBeCloseTo(0.4);
    expect(toEmotionPrompt(first.emotion)).toContain('精神节奏偏低');
  });

  it('feeds one shared structured weather snapshot into the real reply prompt', async () => {
    let promptSnapshot = null;
    let systemPrompt = '';
    const relationship = {
      closeness: 0.6,
      trust: 0.6,
      tension: 0,
      repair_debt: 0,
    };
    const orchestrator = new Orchestrator({
      userId: 'world-affect-orchestrator',
      deps: {
        now: () => NOW,
        memory: {
          recall: async () => ({ block: '', hits: [] }),
          observe: async () => null,
          dismissProspective: async () => null,
        },
        stateLayer: {
          snapshot: async () => ({
            emotion: { valence: 0.2, warmth: 0.7 },
            mood: { valence: 0.2, arousal: 0.5 },
            relationship,
            life: { energy: 0.7, health: 1 },
            desires: {},
            intimacy: { scene_phase: 'none' },
          }),
          evolve: async () => null,
          toPrompt: (snapshot) => {
            promptSnapshot = clone(snapshot);
            return toEmotionPrompt(snapshot.emotion);
          },
          samplingHints: () => ({}),
        },
        relationship: {
          current: async () => ({ relationship }),
          bump: async () => null,
          toPrompt: () => '',
        },
        persona: {
          load: async () => null,
          toPrompt: () => '保持自然',
        },
        world: {
          current: async () => materializeWorldState({
            stable_facts: { city: '上海' },
          }, NOW),
          weather: async () => ({
            temperature: 8,
            condition: '小雨',
            humidity: 88,
          }),
          toPrompt: (state, opts) => toWorldPrompt(state, {
            ...opts,
            includeCalendar: true,
          }),
          evolve: async () => null,
        },
        llm: {
          generateReply: async (messages) => {
            systemPrompt =
              messages.find((message) => message.role === 'system')?.content ??
              '';
            return '知道啦';
          },
        },
      },
      options: { useMonologue: false },
    });

    await orchestrator.reply('今天怎么样', {
      eventId: 'world-affect-turn',
      skipCoherenceRetry: true,
    });
    expect(promptSnapshot.emotion.valence).toBeCloseTo(0.15);
    expect(promptSnapshot.emotion.arousal).toBeCloseTo(0.4);
    expect(systemPrompt).toContain('上海现在小雨');
    expect(systemPrompt).toContain('湿度 88%');
    expect(systemPrompt).toContain('精神节奏偏低');
  });
});
