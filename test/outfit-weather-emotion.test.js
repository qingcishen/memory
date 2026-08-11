import { describe, expect, it } from 'vitest';
import {
  composeDailyLook,
  enforceWeatherOutfit,
  ensureDailyLookState,
  seedRng,
  weatherToOutfitHint,
} from '../src/state/dailyLook.js';
import {
  applyEmotionToContext,
  applyEmotionToLook,
  emotionToOutfitHint,
  hasBreathableFabric,
  hasCoveredShoes,
  hasWarmLayer,
  inferOutfitContext,
  normalizeWardrobe,
  defaultOutfitState,
  evolveOutfitState,
  OutfitDimension,
  pickOutfit,
} from '../src/state/outfit.js';

const CONTEXTS = ['home', 'work', 'date', 'outing', 'sport', 'sleep', 'intimate', 'sick'];
const DATE_START = Date.parse('2026-07-01T04:00:00.000Z');

function simulatePreferredDateLooks(days) {
  let state = defaultOutfitState({
    preferred_ids: ['date_night'],
  });
  const ids = [];
  for (let day = 0; day < days; day++) {
    const result = ensureDailyLookState(state, {
      life: { current_activity: '在餐厅约会' },
      intimacy: { scene_phase: 'none' },
      now: DATE_START + day * 86400000,
    });
    state = result.state;
    ids.push(state.current?.id);
  }
  return { ids, state };
}

describe('O-1 天气穿搭闭环', () => {
  it('按严格温度边界生成天气提示，空温度不会被当作 0°C', () => {
    expect(weatherToOutfitHint({ temperature: 14.9 }).styleHint).toContain('layering');
    expect(weatherToOutfitHint({ temperature: 15 }).styleHint || '').not.toContain('layering');
    expect(weatherToOutfitHint({ temperature: 30 }).styleHint || '').not.toContain('breathable');
    expect(weatherToOutfitHint({ temperature: 30.1 }).styleHint).toContain('breathable');
    expect(weatherToOutfitHint({ temperature: null })).toEqual({});
    expect(weatherToOutfitHint({ temperature: '   ' })).toEqual({});
    expect(weatherToOutfitHint({ temperature: false })).toEqual({});
    expect(weatherToOutfitHint({ condition: '雷阵雨' }).styleHint).toContain('rain-proof');
  });

  it('pickOutfit 会实际消费 layering / breathable / rain-proof 提示', () => {
    const wardrobe = normalizeWardrobe({
      wardrobe: [
        {
          id: 'plain',
          context: 'outing',
          summary: '普通上衣，凉鞋',
          pieces: { top: '普通上衣', shoes: '露趾凉鞋' },
        },
        {
          id: 'layered',
          context: 'outing',
          summary: '针织上衣，羊绒大衣，凉鞋',
          pieces: { top: '针织上衣', outer: '羊绒大衣', shoes: '露趾凉鞋' },
        },
        {
          id: 'summer',
          context: 'outing',
          summary: '轻薄透气亚麻上衣，凉鞋',
          pieces: { top: '轻薄透气亚麻上衣', shoes: '露趾凉鞋' },
        },
        {
          id: 'rain',
          context: 'outing',
          summary: '普通上衣，防水包头短靴',
          pieces: { top: '普通上衣', shoes: '防水包头短靴' },
        },
      ],
    });

    expect(pickOutfit(wardrobe, 'outing', { styleHint: 'layering', rng: () => 0 }).id).toBe('layered');
    expect(pickOutfit(wardrobe, 'outing', { styleHint: 'breathable', rng: () => 0 }).id).toBe('summer');
    expect(pickOutfit(wardrobe, 'outing', { styleHint: 'rain-proof', rng: () => 0 }).id).toBe('rain');
  });

  it('100 次低温模拟最终都含保暖外层', () => {
    for (let i = 0; i < 100; i++) {
      const temperature = -12 + (i % 27);
      const { look } = composeDailyLook({
        context: CONTEXTS[i % CONTEXTS.length],
        dailyKey: `cold-${i}`,
        weatherContext: { temperature, condition: i % 3 === 0 ? 'windy' : 'clear' },
        rng: seedRng(`cold-${i}`),
      });
      expect(hasWarmLayer(look), `simulation ${i}, ${temperature}°C`).toBe(true);
    }
  });

  it('100 次高温模拟最终都使用透气核心面料且移除厚重外层', () => {
    for (let i = 0; i < 100; i++) {
      const temperature = 31 + (i % 10);
      const { look } = composeDailyLook({
        context: CONTEXTS[i % CONTEXTS.length],
        dailyKey: `hot-${i}`,
        weatherContext: { temperature, condition: 'sunny' },
        rng: seedRng(`hot-${i}`),
      });
      expect(hasBreathableFabric(look), `simulation ${i}, ${temperature}°C`).toBe(true);
      expect(String(look?.pieces?.outer || '')).not.toMatch(/羊绒|羊毛|毛呢|大衣|羽绒/);
    }
  });

  it('100 次雨天模拟最终都换成包覆式鞋履', () => {
    for (let i = 0; i < 100; i++) {
      const { look } = composeDailyLook({
        context: CONTEXTS[i % CONTEXTS.length],
        dailyKey: `rain-${i}`,
        weatherContext: { temperature: 20, condition: i % 2 ? 'rain showers' : '雷阵雨' },
        rng: seedRng(`rain-${i}`),
      });
      expect(hasCoveredShoes(look), `rain simulation ${i}`).toBe(true);
    }
  });

  it('最终守卫在抽屉覆盖后仍补齐三项约束，且不改 id/context/内搭', () => {
    const original = {
      id: 'intimate-white-shirt',
      context: 'intimate',
      summary: '他的白衬衫，露趾穆勒鞋',
      pieces: {
        top: '他的白衬衫',
        lingerie: 'La Perla 黑色蕾丝套装',
        shoes: '露趾穆勒鞋',
      },
    };
    const guarded = enforceWeatherOutfit(original, null, {
      temperature: 10,
      condition: 'rain',
    }, { rng: () => 0 });

    expect(guarded).toMatchObject({
      id: original.id,
      context: 'intimate',
      pieces: {
        top: original.pieces.top,
        lingerie: original.pieces.lingerie,
      },
    });
    expect(hasWarmLayer(guarded)).toBe(true);
    expect(hasCoveredShoes(guarded)).toBe(true);
  });
});

describe('O-5 情绪穿搭闭环', () => {
  it('无聊/烦躁回到居家休闲，期待进入约会，开心保留情境并开放亮色', () => {
    expect(emotionToOutfitHint('无聊', 'outing')).toEqual({
      context: 'home',
      styleHint: 'casual relaxed',
    });
    expect(applyEmotionToContext('烦躁', 'date')).toBe('home');
    expect(applyEmotionToContext('期待', 'home')).toBe('date');
    expect(emotionToOutfitHint('开心', 'outing')).toEqual({
      context: 'outing',
      styleHint: 'bright-color',
    });

    const happy = applyEmotionToLook({
      id: 'neutral',
      context: 'outing',
      summary: '白色衬衫，黑色长裤',
      pieces: { top: '白色衬衫', bottom: '黑色长裤' },
    }, '开心');
    expect(`${happy?.summary} ${happy?.style}`).toMatch(/明快|亮色|彩色/);
  });

  it('composeDailyLook 把情绪映射落实到最终 context 和可读穿搭', () => {
    const bored = composeDailyLook({
      context: 'outing',
      emotionLabel: '无聊',
      dailyKey: 'emotion-bored',
    });
    const anticipated = composeDailyLook({
      context: 'home',
      emotionLabel: '期待',
      dailyKey: 'emotion-anticipated',
    });
    const happy = composeDailyLook({
      context: 'outing',
      emotionLabel: '开心',
      dailyKey: 'emotion-happy',
    });

    expect(bored.context).toBe('home');
    expect(bored.look?.context).toBe('home');
    expect(anticipated.context).toBe('date');
    expect(anticipated.look?.context).toBe('date');
    expect(`${happy.look?.summary} ${happy.look?.style}`).toMatch(/明快|亮色|彩色/);
  });

  it.each(['无聊', '烦躁', '期待', '开心'])('%s 不覆盖亲密 context 或亲密内搭', (emotionLabel) => {
    expect(applyEmotionToContext(emotionLabel, 'intimate')).toBe('intimate');
    expect(inferOutfitContext({
      hour: 22,
      intimacy: { scene_phase: 'foreplay' },
      emotionLabel,
    })).toBe('intimate');

    const { look, context } = composeDailyLook({
      context: 'intimate',
      emotionLabel,
      weatherContext: { temperature: 12, condition: 'rain' },
      dailyKey: `intimate-${emotionLabel}`,
    });
    expect(context).toBe('intimate');
    expect(look?.context).toBe('intimate');
    expect(look?.pieces?.top).toContain('白衬衫');
    expect(look?.pieces?.lingerie).toBeTruthy();
  });
});

describe('O-1/O-3/O-4/O-5 production wiring', () => {
  it('raises a liked look selection rate in a 100-vs-100 A/B simulation', () => {
    const wardrobe = {
      wardrobe: [
        {
          id: 'liked',
          context: 'outing',
          summary: '喜欢的真丝上衣，长裤，包头鞋',
          pieces: {
            top: '喜欢的真丝上衣',
            bottom: '长裤',
            shoes: '包头鞋',
          },
        },
        {
          id: 'neutral',
          context: 'outing',
          summary: '普通上衣，长裤，包头鞋',
          pieces: { top: '普通上衣', bottom: '长裤', shoes: '包头鞋' },
        },
      ],
    };
    let controlHits = 0;
    let treatmentHits = 0;
    for (let index = 0; index < 100; index++) {
      const rng = () => (index % 2 === 0 ? 0 : 0.99);
      const control = composeDailyLook({
        wardrobe,
        context: 'outing',
        dailyKey: `control-${index}`,
        rng,
      });
      const treatment = composeDailyLook({
        wardrobe,
        context: 'outing',
        dailyKey: `treatment-${index}`,
        rng,
        outfitPrefs: { preferred_ids: ['liked'], disliked_ids: [] },
      });
      if (control.look?.id === 'liked') controlHits++;
      if (treatment.look?.id === 'liked') treatmentHits++;
    }
    expect(controlHits).toBe(50);
    expect(treatmentHits).toBe(100);
    expect(treatmentHits).toBeGreaterThan(controlHits * 1.5);
  });

  it('OutfitDimension consumes its shared world weather provider before persisting the daily look', async () => {
    let stored = defaultOutfitState();
    const now = Date.parse('2026-01-10T04:00:00.000Z');
    const dimension = new OutfitDimension({
      userId: 'outfit-weather-production',
      now: () => now,
      read: async () => stored,
      write: async (_userId, _companionId, next) => {
        stored = next;
        return next;
      },
      weatherProvider: async () => ({
        temperature: 8,
        condition: '小雨',
        humidity: 86,
      }),
    });

    const snapshot = await dimension.snapshot({
      life: { current_activity: '在家休息' },
      intimacy: { scene_phase: 'none' },
    });
    expect(hasWarmLayer(snapshot.current)).toBe(true);
    expect(hasCoveredShoes(snapshot.current)).toBe(true);
    expect(stored.current?.id).toBe(snapshot.current?.id);
  });

  it('intimacy phase changes bypass the ordinary 30-minute outfit cooldown', () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    const recentHome = defaultOutfitState({
      current: {
        id: 'recent-home',
        context: 'home',
        summary: '居家针织衫，长裤，包头平底鞋',
        pieces: {
          top: '居家针织衫',
          bottom: '长裤',
          shoes: '包头平底鞋',
        },
      },
      context: 'home',
      changed_at: new Date(now - 5 * 60 * 1000).toISOString(),
    });
    const intimate = evolveOutfitState(recentHome, {
      hour: 20,
      intimacy: { scene_phase: 'foreplay' },
      now,
    });
    expect(intimate.context).toBe('intimate');
    expect(intimate.current?.context).toBe('intimate');

    const aftercare = evolveOutfitState(intimate, {
      hour: 20,
      intimacy: { scene_phase: 'aftercare' },
      now: now + 60 * 1000,
    });
    expect(aftercare.context).toBe('home');
  });

  it('switches correctly in 100 recent-outfit intimacy transitions', () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    for (let index = 0; index < 100; index++) {
      const current = defaultOutfitState({
        current: {
          id: `home-${index}`,
          context: 'home',
          summary: '居家上衣，长裤，包头鞋',
          pieces: {
            top: '居家上衣',
            bottom: '长裤',
            shoes: '包头鞋',
          },
        },
        context: 'home',
        changed_at: new Date(now - (index % 10) * 60 * 1000).toISOString(),
      });
      const next = evolveOutfitState(current, {
        hour: 20,
        intimacy: {
          scene_phase: index % 2 === 0 ? 'flirting' : 'foreplay',
        },
        now,
      });
      expect(next.context, `transition ${index}`).toBe('intimate');
    }
  });

  it('keeps seven consecutive default date looks unique', () => {
    let state = defaultOutfitState();
    const ids = [];
    const start = Date.parse('2026-07-01T04:00:00.000Z');
    for (let day = 0; day < 7; day++) {
      const result = ensureDailyLookState(state, {
        life: { current_activity: '在餐厅约会' },
        intimacy: { scene_phase: 'none' },
        now: start + day * 86400000,
      });
      state = result.state;
      ids.push(state.current?.id);
    }
    expect(new Set(ids).size).toBe(7);
    expect(state.recent_looks).toHaveLength(7);
  });

  it('keeps a preferred date look from bypassing seven-day deduplication', () => {
    const { ids, state } = simulatePreferredDateLooks(7);

    expect(ids[0]).toBe('date_night');
    expect(new Set(ids).size).toBe(7);
    expect(ids.slice(1)).not.toContain('date_night');
    expect(state.recent_looks).toHaveLength(7);
  });

  it('allows the preferred date look again on day eight only after the pool is exhausted', () => {
    const { ids, state } = simulatePreferredDateLooks(8);

    expect(new Set(ids.slice(0, 7)).size).toBe(7);
    expect(ids[7]).toBe('date_night');
    expect(ids.filter((id) => id === 'date_night')).toHaveLength(2);
    expect(state.recent_looks).toHaveLength(8);
  });

  it('passes the production emotion label into immediate context switching', async () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    let stored = defaultOutfitState({
      current: {
        id: 'neutral-home',
        context: 'home',
        summary: '白色上衣，长裤，包头平底鞋',
        pieces: {
          top: '白色上衣',
          bottom: '长裤',
          shoes: '包头平底鞋',
        },
      },
      context: 'home',
      daily_key: '2026-07-29',
      changed_at: new Date(now - 5 * 60 * 1000).toISOString(),
    });
    const dimension = new OutfitDimension({
      userId: 'outfit-emotion-production',
      now: () => now,
      read: async () => stored,
      write: async (_userId, _companionId, next) => {
        stored = next;
        return next;
      },
    });

    const next = await dimension.evolve([], {
      life: { current_activity: '在家休息' },
      intimacy: { scene_phase: 'none' },
      emotionLabel: '期待',
    });
    expect(next.context).toBe('date');
    expect(next.current?.context).toBe('date');
    expect(next.current?.style).toContain('精致期待感');
  });

  it('reports the pre-change outfit id so “换一套” dislikes the old look', async () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    const stored = defaultOutfitState({
      current: {
        id: 'old-look',
        context: 'home',
        summary: '旧居家装，包头鞋',
        pieces: { top: '旧居家装', shoes: '包头鞋' },
      },
      context: 'home',
      daily_key: '2026-07-29',
      changed_at: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    const dimension = new OutfitDimension({
      userId: 'outfit-feedback-production',
      now: () => now,
      read: async () => stored,
      write: async (_userId, _companionId, next) => next,
    });
    const next = await dimension.evolve(
      [{ role: 'user', content: '这套不好看，换一套' }],
      {
        life: { current_activity: '在家休息' },
        intimacy: { scene_phase: 'none' },
      },
    );
    expect(next._meta.previousOutfitId).toBe('old-look');
    expect(next.current?.id).not.toBe('old-look');
  });
});
