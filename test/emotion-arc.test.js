import { describe, expect, it } from 'vitest';
import {
  continuousStateFromRow,
  continuousStateToPrompt,
  continuousStateToRow,
  createExistenceEngine,
  createMemoryContinuousStateStore,
  createMemoryPersonalityStore,
  createMemoryPrivateMemoryStore,
  defaultContinuousState,
  heartbeatTick,
  mergeEmotionArcJournals,
  normalizeContinuousState,
  updateEmotionArc,
} from '../src/existence/index.js';

const DAY = 24 * 60 * 60 * 1000;
const DAY_1 = Date.parse('2026-07-20T12:00:00.000Z');
const DAY_3 = DAY_1 + 2 * DAY;

function event(dayOffset, label, intensity = 0.8) {
  return {
    at: DAY_1 + dayOffset * DAY,
    toLabel: label,
    intensity,
  };
}

describe('E-4 seven-day emotion arc', () => {
  it('normalizes the required labels/dominant/trend state shape', () => {
    const state = normalizeContinuousState({
      emotional: {
        weekly_distribution: {
          labels: { 开心: 2, 生气: 1, invalid: -2 },
          dominant: '开心',
          trend: 'improving',
        },
      },
    });

    expect(state.emotional.weekly_distribution).toEqual({
      labels: { 开心: 2, 生气: 1 },
      dominant: '开心',
      trend: 'improving',
    });
    expect(state.emotional.emotion_history).toEqual([]);
  });

  it('computes an accurate improving distribution from three simulated days', () => {
    const arc = updateEmotionArc(
      [
        event(0, '生气'),
        event(0, '生气'),
        event(1, '平静'),
        event(2, '开心'),
        event(2, '开心'),
        event(2, '开心'),
      ],
      { now: DAY_3 + 60_000, timezoneOffsetMinutes: 8 * 60 },
    );

    expect(arc.weekly_distribution).toEqual({
      labels: { 生气: 2, 平静: 1, 开心: 3 },
      dominant: '开心',
      trend: 'improving',
    });
  });

  it('distinguishes a declining arc and a stable arc', () => {
    const declining = updateEmotionArc(
      [event(0, '开心'), event(1, '平静'), event(2, '失落')],
      { now: DAY_3 + 60_000 },
    );
    const stable = updateEmotionArc(
      [event(0, '平静'), event(1, '平静'), event(2, '平静')],
      { now: DAY_3 + 60_000 },
    );

    expect(declining.weekly_distribution.trend).toBe('declining');
    expect(stable.weekly_distribution.trend).toBe('stable');
  });

  it('merges rolling legacy journal pages without duplicating prior events', () => {
    const merged = mergeEmotionArcJournals(
      [event(0, '失落'), event(1, '平静')],
      [event(1, '平静'), event(2, '开心')],
    );

    expect(merged.map((row) => row.label)).toEqual([
      '失落',
      '平静',
      '开心',
    ]);
  });

  it('heartbeat persists a refreshed arc and removes events outside seven days', async () => {
    const state = defaultContinuousState(DAY_1);
    state.emotional.emotion_history = [
      event(0, '生气'),
      event(5, '平静'),
      event(8, '开心'),
    ];
    state.emotional.weekly_distribution = {
      labels: { 生气: 1, 平静: 1, 开心: 1 },
      dominant: '开心',
      trend: 'improving',
    };

    const store = createMemoryContinuousStateStore({
      initial: [{ userId: 'heartbeat-user', companionId: 'c', state }],
      clock: () => DAY_1 + 8 * DAY,
    });
    const evolved = await heartbeatTick('heartbeat-user', 'c', {
      store,
      now: DAY_1 + 8 * DAY,
      timezoneOffsetMinutes: 8 * 60,
      computeDesire: () => 0,
    });

    expect(evolved.emotional.emotion_history.map((row) => row.label)).toEqual([
      '平静',
      '开心',
    ]);
    expect(evolved.emotional.weekly_distribution.labels).toEqual({
      平静: 1,
      开心: 1,
    });
    expect(evolved.emotional.weekly_distribution.dominant).toBe('开心');
    expect(
      (await store.load({ userId: 'heartbeat-user', companionId: 'c' }))
        .emotional.weekly_distribution,
    ).toEqual(evolved.emotional.weekly_distribution);
  });

  it('updates the persisted CEE projection from emotionJournal on turn commit', async () => {
    const stateStore = createMemoryContinuousStateStore({
      initial: [
        {
          userId: 'arc-user',
          companionId: 'arc-companion',
          state: defaultContinuousState(DAY_1),
        },
      ],
      clock: () => DAY_3,
    });
    const engine = createExistenceEngine({
      userId: 'arc-user',
      companionId: 'arc-companion',
      stateStore,
      personalityStore: createMemoryPersonalityStore(),
      privateMemoryStore: createMemoryPrivateMemoryStore(),
      clock: () => DAY_3,
      timezoneOffsetMinutes: 8 * 60,
    });
    const journal = [
      event(0, '失落'),
      event(1, '平静'),
      event(2, '开心'),
      { ...event(2, '开心'), at: DAY_3 + 30_000 },
    ];

    await engine.observeTurn({
      eventId: 'arc-day-3',
      now: DAY_3 + 60_000,
      userMessage: '今天好多了',
      reply: '嗯，听得出来。',
      emotionLabel: '开心',
      emotionJournal: journal,
    });
    const saved = await engine.loadState();

    expect(saved.emotional.weekly_distribution).toEqual({
      labels: { 失落: 1, 平静: 1, 开心: 2 },
      dominant: '开心',
      trend: 'improving',
    });
    expect(saved.emotional.emotion_history).toHaveLength(4);
  });

  it('persists the arc through the database row boundary', () => {
    const state = defaultContinuousState(DAY_3);
    state.emotional.weekly_distribution = {
      labels: { 期待: 3 },
      dominant: '期待',
      trend: 'improving',
    };
    state.emotional.emotion_history = [event(2, '期待')];

    const row = continuousStateToRow('u', 'c', state);
    const restored = continuousStateFromRow(row, { now: DAY_3 });

    expect(row.weekly_distribution.dominant).toBe('期待');
    expect(row.emotion_history).toHaveLength(1);
    expect(restored.emotional.weekly_distribution).toEqual(
      state.emotional.weekly_distribution,
    );
    expect(restored.emotional.emotion_history[0].label).toBe('期待');
  });

  it('injects the weekly arc as natural continuity rather than raw statistics', () => {
    const state = defaultContinuousState(DAY_3);
    state.emotional.weekly_distribution = {
      labels: { 失落: 1, 平静: 1, 开心: 2 },
      dominant: '开心',
      trend: 'improving',
    };
    const prompt = continuousStateToPrompt(state);

    expect(prompt).toContain('近七天的情绪弧线整体偏开心');
    expect(prompt).toContain('在慢慢向好');
    expect(prompt).not.toContain('"开心":2');
  });
});
