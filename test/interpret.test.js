import { describe, expect, it } from 'vitest';
import { interpretTurn } from '../src/orchestrator/interpret.js';

describe('Interpret stage', () => {
  it('produces a complete neutral interpretation without IO', () => {
    const result = interpretTurn({
      userMessage: '今天有点累',
      history: [],
      stateSnapshot: {
        mood: { valence: 0, arousal: 0.2 },
        relationship: { closeness: 0.5, tension: 0, trust: 0.5 },
        life: { energy: 0.2, health: 1, satiety: 0.5 },
        desires: {},
      },
      relState: {
        relationship: { closeness: 0.5, tension: 0, trust: 0.5 },
      },
      sessionThread: { updatedAt: new Date().toISOString() },
      now: Date.now(),
    });
    expect(result.emotion.label).toBeTruthy();
    expect(result.relationshipStage.id).toBeTruthy();
    expect(result.bodySituation).toBeTruthy();
    expect(result.sceneLocks).toBeInstanceOf(Array);
    expect(result.unfinished).toBeInstanceOf(Array);
  });

  it('removes desire from prompt state when ablated', () => {
    const result = interpretTurn({
      userMessage: '你好',
      stateSnapshot: {
        desires: { attention: 0.9 },
        life: {},
        relationship: {},
      },
      relState: {},
      ablation: { desire: false, behaviorPolicy: false },
      sessionThreadEnabled: false,
    });
    expect(result.stateForPrompt.desires).toBeNull();
  });
});
