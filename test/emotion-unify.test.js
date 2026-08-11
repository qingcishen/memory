import { describe, expect, it, vi } from 'vitest';
import {
  applyAnomalyToState,
  createExistenceEngine,
  createMemoryContinuousStateStore,
  createMemoryPersonalityStore,
  createMemoryPrivateMemoryStore,
  defaultContinuousState,
  normalizeCeeEmotionLabel,
  sameEmotionDirection,
  selectAuthoritativeEmotionLabel,
  synchronizeCeeEmotion,
} from '../src/existence/index.js';
import {
  inferHeuristicDeltas,
} from '../src/state/affect.js';
import {
  inferEmotionLabelRaw,
} from '../src/state/emotionLabel.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function makeEngine(state = defaultContinuousState(NOW)) {
  const stateStore = createMemoryContinuousStateStore({
    initial: [{ userId: 'e2-user', companionId: 'e2-companion', state }],
    clock: () => NOW,
  });
  const engine = createExistenceEngine({
    userId: 'e2-user',
    companionId: 'e2-companion',
    stateStore,
    personalityStore: createMemoryPersonalityStore(),
    privateMemoryStore: createMemoryPrivateMemoryStore(),
    clock: () => NOW,
  });
  return { engine, stateStore };
}

describe('E-2 unified CEE emotion source', () => {
  it('accepts legacy English emotion names but normalizes them to 16-label CEE values', () => {
    expect(normalizeCeeEmotionLabel('sad')).toBe('失落');
    expect(normalizeCeeEmotionLabel('excited')).toBe('期待');
    expect(normalizeCeeEmotionLabel('anxious')).toBe('担心');
    expect(normalizeCeeEmotionLabel('害羞')).toBe('害羞');
  });

  it('keeps a persisted CEE label authoritative over a turn fallback', () => {
    expect(
      selectAuthoritativeEmotionLabel(
        {
          label: '感动',
          current_emotion: 'happy',
          emotion_intensity: 0.8,
          persistence: 2,
        },
        '生气',
      ),
    ).toBe('感动');
  });

  it('uses M1 valence only as the numeric base without reclassifying the CEE label', () => {
    const emotional = synchronizeCeeEmotion(
      {
        current_emotion: 'neutral',
        emotion_intensity: 0,
        persistence: 0,
      },
      {
        label: '委屈',
        emotion: { valence: -0.63 },
      },
    );

    expect(emotional.label).toBe('委屈');
    expect(emotional.current_emotion).toBe('委屈');
    expect(emotional.valence).toBe(-0.63);
    expect(sameEmotionDirection(emotional, { valence: -0.63 })).toBe(true);
  });

  it('does not fabricate intensity for neutral rest state', () => {
    const emotional = synchronizeCeeEmotion(
      defaultContinuousState(NOW).emotional,
      { label: '平静', emotion: { valence: 0 }, minPersistence: 0 },
    );

    expect(emotional.emotion_intensity).toBe(0);
    expect(emotional.persistence).toBe(0);
  });

  it('uses CEE label and M1 valence together in the generated turn context', async () => {
    const state = defaultContinuousState(NOW);
    state.emotional.label = '担心';
    state.emotional.current_emotion = 'worried';
    state.emotional.emotion_intensity = 0.7;
    state.emotional.persistence = 2;
    const { engine } = makeEngine(state);

    const turn = await engine.contextForTurn({
      now: NOW,
      emotion: { current_emotion: 'happy', valence: -0.42 },
    });

    expect(turn.state.emotional.label).toBe('担心');
    expect(turn.state.emotional.valence).toBe(-0.42);
    expect(turn.activePersonality.runtime_state.current_emotion).toBe('担心');
    expect(turn.activePersonality.runtime_state.valence).toBe(-0.42);
  });

  it('persists one authoritative label with the M1 numeric value at commit', async () => {
    const { engine } = makeEngine();

    await engine.observeTurn({
      eventId: 'e2-commit',
      now: NOW,
      userMessage: '其实我有点难过',
      reply: '我听到了。',
      emotionLabel: '委屈',
      emotion: { valence: -0.55 },
    });
    const state = await engine.loadState();

    expect(state.emotional.label).toBe('委屈');
    expect(state.emotional.current_emotion).toBe('委屈');
    expect(state.emotional.valence).toBe(-0.55);
  });

  it('syncs the post-turn M1 numeric state without replacing the CEE label', async () => {
    const state = defaultContinuousState(NOW);
    state.emotional.label = '开心';
    state.emotional.current_emotion = '开心';
    state.emotional.emotion_intensity = 0.7;
    state.emotional.persistence = 2;
    const { engine } = makeEngine(state);

    const synced = await engine.syncNumericEmotion({
      mood: { valence: 0.46, arousal: 0.7 },
    });

    expect(synced.emotional.label).toBe('开心');
    expect(synced.emotional.current_emotion).toBe('开心');
    expect(synced.emotional.valence).toBe(0.46);
  });

  it('runAfterReply forwards Memory.observe final M1 state into CEE', async () => {
    const syncNumericEmotion = vi.fn(async () => null);
    const fake = {
      stateLayer: { evolve: vi.fn(async () => null) },
      memory: {
        observe: vi.fn(async () => ({
          state: { mood: { valence: -0.38, arousal: 0.6 } },
        })),
      },
      relationship: { bump: vi.fn(async () => null) },
      world: null,
      existence: { syncNumericEmotion },
      maybeRecordEpisode: vi.fn(async () => null),
      now: () => NOW,
    };

    await Orchestrator.prototype.runAfterReply.call(
      fake,
      '我真的有点难过',
      '我听到了。',
      {},
    );

    expect(syncNumericEmotion).toHaveBeenCalledWith({
      mood: { valence: -0.38, arousal: 0.6 },
    });
  });

  it('independent M1 deltas and CEE labels agree in at least 85 of 100 turns', () => {
    const positive = [
      '我好喜欢你',
      '爱你，今天特别开心',
      '谢谢你一直陪着我',
      '想你了宝贝',
      '哈哈今天真开心',
    ];
    const negative = [
      '我很生气，你太过分了',
      '你这样真的让我很伤心',
      '烦死了，不想理你',
      '我很失望，别理我',
      '你又冷落我，我很难过',
    ];
    const positiveLabels = new Set([
      '开心', '撒娇', '期待', '害羞', '暧昧', '感动', '骄傲',
    ]);
    const negativeLabels = new Set([
      '委屈', '吃醋', '生气', '失落', '担心', '无聊', '烦躁',
    ]);
    let aligned = 0;
    for (let index = 0; index < 100; index += 1) {
      const isPositive = index % 2 === 0;
      const text = isPositive
        ? positive[index % positive.length]
        : negative[index % negative.length];
      const turns = [{ role: 'user', content: `${text} ${index}` }];
      const m1Valence = inferHeuristicDeltas(turns).mood.valence;
      const ceeLabel = inferEmotionLabelRaw(
        {
          emotion: { valence: m1Valence },
          relationship: {
            closeness: 0.7,
            tension: m1Valence < 0 ? 0.3 : 0,
            repair_debt: m1Valence < 0 ? 0.2 : 0,
          },
        },
        {},
        turns,
      );
      if (
        (m1Valence > 0 && positiveLabels.has(ceeLabel)) ||
        (m1Valence < 0 && negativeLabels.has(ceeLabel))
      ) {
        aligned += 1;
      }
    }

    expect(aligned).toBeGreaterThanOrEqual(85);
    expect(aligned).toBe(100);
  });

  it('writes unified labels for temporal prediction anomalies', () => {
    const early = applyAnomalyToState(
      { type: 'too_fast', magnitude: 20 },
      defaultContinuousState(NOW),
    );
    const late = applyAnomalyToState(
      { type: 'too_slow', magnitude: 50 },
      defaultContinuousState(NOW),
    );

    expect(early.emotional.label).toBe('期待');
    expect(early.emotional.valence).toBeGreaterThan(0);
    expect(late.emotional.label).toBe('担心');
    expect(late.emotional.valence).toBeLessThan(0);
  });
});
