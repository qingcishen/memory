import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/extract.js', () => ({
  extractMemories: vi.fn(async () => []),
  applyMoodShiftBoost: vi.fn((memories) => memories),
}));

vi.mock('../src/store.js', () => ({
  storeMemories: vi.fn(async () => []),
}));

vi.mock('../src/state/affect.js', () => ({
  readState: vi.fn(async () => null),
  updateFromTurn: vi.fn(async () => ({
    before: null,
    after: null,
    desireDeltas: null,
  })),
  decayToBaseline: vi.fn(async () => null),
  moodLabel: vi.fn(() => '平静'),
  moodShiftMagnitude: vi.fn(() => 0),
  readStateHistory: vi.fn(async () => []),
}));

import {
  OutfitDimension,
  clampOutfitState,
  defaultOutfitState,
} from '../src/state/outfit.js';
import {
  composeDailyLook,
  localDayKey,
} from '../src/state/dailyLook.js';
import { scanOutfitFeedback } from '../src/state/outfitPreference.js';

const { Memory } = await import('../src/memory.js');

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-07-29T04:00:00.000Z');
const WARDROBE = {
  defaults: {},
  seasonal: {},
  wardrobe: [
    {
      id: 'silk-liked',
      context: 'home',
      summary: '真丝上衣，舒适长裤，包头软鞋',
      pieces: {
        top: '真丝上衣',
        bottom: '舒适长裤',
        shoes: '包头软鞋',
      },
    },
    {
      id: 'knit-neutral',
      context: 'home',
      summary: '针织上衣，舒适长裤，包头软鞋',
      pieces: {
        top: '针织上衣',
        bottom: '舒适长裤',
        shoes: '包头软鞋',
      },
    },
    {
      id: 'linen-neutral',
      context: 'home',
      summary: '亚麻上衣，舒适长裤，包头软鞋',
      pieces: {
        top: '亚麻上衣',
        bottom: '舒适长裤',
        shoes: '包头软鞋',
      },
    },
  ],
};
const CONFIG = {
  enabled: true,
  minHoursBeforeSwitch: 0.5,
  maxHoursSameOutfit: 16,
  dailyLook: {
    enabled: true,
    autoCompose: true,
    rotateAccessories: false,
    timezoneOffsetMinutes: 480,
  },
};

function wardrobeLook(id) {
  return WARDROBE.wardrobe.find((look) => look.id === id);
}

function createProductionHarness(initialState) {
  let now = START;
  let stored = clampOutfitState(initialState);
  const writes = [];
  const outfit = new OutfitDimension({
    userId: 'o2-user',
    companionId: 'o2-companion',
    wardrobe: WARDROBE,
    config: CONFIG,
    now: () => now,
    read: async () => stored,
    write: async (_userId, _companionId, next) => {
      stored = clampOutfitState(next);
      writes.push(stored);
      return stored;
    },
  });
  const memory = new Memory({
    userId: 'o2-user',
    companionId: 'o2-companion',
  });
  const life = {
    evolve: vi.fn(async () => null),
    current: vi.fn(async () => ({ current_activity: '在家休息' })),
  };
  return {
    memory,
    outfit,
    life,
    getStored: () => stored,
    getWrites: () => writes,
    setCurrent: (id) => {
      stored = clampOutfitState({
        ...stored,
        current: wardrobeLook(id),
        context: 'home',
        changed_at: new Date(now).toISOString(),
      });
    },
    advanceDay: () => {
      now += DAY;
      return now;
    },
  };
}

async function observeOutfitFeedback(harness, content) {
  return harness.memory.observe(
    [
      { role: 'user', content },
      { role: 'assistant', content: '知道了。' },
    ],
    {
      outfit: harness.outfit,
      life: harness.life,
      now: START,
      prospective: false,
      knowledge: false,
      useLLM: false,
      autoForget: false,
    },
  );
}

function selectionRate(targetId, outfitPrefs = null) {
  let hits = 0;
  for (let index = 0; index < 100; index++) {
    const result = composeDailyLook({
      wardrobe: WARDROBE,
      context: 'home',
      dailyKey: `o2-rate-${index}`,
      rotateAccessories: false,
      rng: () => index / 100,
      outfitPrefs,
    });
    if (result.look?.id === targetId) hits++;
  }
  return hits / 100;
}

describe('O-2 production preference loop', () => {
  it('persists praise for the current look and raises its next-selection rate', async () => {
    const harness = createProductionHarness(defaultOutfitState({
      current: wardrobeLook('silk-liked'),
      context: 'home',
      daily_key: localDayKey(START),
      changed_at: new Date(START - 60 * 60 * 1000).toISOString(),
    }));

    const observed = await observeOutfitFeedback(
      harness,
      '你现在这套真好看，我很喜欢。',
    );
    const stored = harness.getStored();

    expect(observed.outfitFeedback).toEqual({
      ratedOutfitId: 'silk-liked',
      liked: ['silk-liked'],
      disliked: [],
      persisted: true,
    });
    expect(observed.outfit?.preferred_ids).toEqual(['silk-liked']);
    expect(stored.preferred_ids).toEqual(['silk-liked']);
    expect(stored.disliked_ids).toEqual([]);
    expect(harness.getWrites().length).toBeGreaterThanOrEqual(2);

    const controlRate = selectionRate('silk-liked');
    const learnedRate = selectionRate('silk-liked', stored);
    expect(controlRate).toBeCloseTo(0.34, 2);
    expect(learnedRate).toBe(1);
    expect(learnedRate).toBeGreaterThan(controlRate);

    // 模拟本日稍后已换成另一套，避开 O-3 的“当前款不连穿”约束；下一日仍走
    // 真实 OutfitDimension.snapshot 验证它会从持久化 state 读取偏好。
    harness.setCurrent('knit-neutral');
    harness.advanceDay();
    const nextDailyLook = await harness.outfit.snapshot({
      life: { current_activity: '在家休息' },
    });
    expect(nextDailyLook.current?.id).toBe('silk-liked');
    expect(nextDailyLook.preferred_ids).toEqual(['silk-liked']);
  });

  it('rates the just-removed look as disliked, preserves old prefs, and suppresses it later', async () => {
    const harness = createProductionHarness(defaultOutfitState({
      current: wardrobeLook('silk-liked'),
      context: 'home',
      daily_key: localDayKey(START),
      changed_at: new Date(START - 60 * 60 * 1000).toISOString(),
      preferred_ids: ['knit-neutral'],
    }));

    const observed = await observeOutfitFeedback(
      harness,
      '这套不好看，给我换一套。',
    );
    const stored = harness.getStored();

    expect(observed.outfitFeedback).toEqual({
      ratedOutfitId: 'silk-liked',
      liked: [],
      disliked: ['silk-liked'],
      persisted: true,
    });
    expect(stored.current?.id).toBe('knit-neutral');
    expect(stored.preferred_ids).toEqual(['knit-neutral']);
    expect(stored.disliked_ids).toEqual(['silk-liked']);

    const controlRate = selectionRate('silk-liked');
    const learnedRate = selectionRate('silk-liked', stored);
    expect(controlRate).toBeGreaterThan(0.3);
    expect(learnedRate).toBe(0);
    expect(learnedRate).toBeLessThan(controlRate);

    harness.advanceDay();
    const nextDailyLook = await harness.outfit.snapshot({
      life: { current_activity: '在家休息' },
    });
    expect(nextDailyLook.current?.id).not.toBe('silk-liked');
    expect(nextDailyLook.disliked_ids).toContain('silk-liked');
  });

  it('uses only the latest user feedback and never treats “不好看” as praise', () => {
    expect(scanOutfitFeedback([
      { role: 'user', content: '上一轮我说过这套好看。' },
      { role: 'assistant', content: '嗯。' },
      { role: 'user', content: '但现在看这套不好看，换掉吧。' },
    ], 'look-1')).toEqual({
      liked: [],
      disliked: ['look-1'],
    });
  });
});
