import { describe, expect, it } from 'vitest';
import { perceiveTurn } from '../src/orchestrator/perceive.js';

describe('Perceive stage', () => {
  it('expires old physical scenes without mutating caller history', () => {
    const history = [{ role: 'user', content: '在饭店' }];
    const result = perceiveTurn({
      userMessage: '我回来了',
      history,
      lastUserMessageAt: 0,
      storedLastUserMessageAt: '2026-07-28T00:00:00.000Z',
      now: new Date('2026-07-28T05:00:00.000Z').getTime(),
      previousSceneType: 'dining',
      sessionThread: { updatedAt: '2026-07-28T00:00:00.000Z' },
    });
    expect(result.gapHours).toBe(5);
    expect(result.history).toEqual([]);
    expect(result.previousSceneType).toBeNull();
    expect(result.sessionReset).toBe(true);
    expect(history).toHaveLength(1);
  });

  it('keeps a recent session intact', () => {
    const sessionThread = { updatedAt: new Date().toISOString(), topic: '工作' };
    const result = perceiveTurn({
      userMessage: '继续说',
      history: [{ role: 'assistant', content: '好' }],
      lastUserMessageAt: 9_000,
      now: 10_000,
      sessionThread,
    });
    expect(result.history).toHaveLength(1);
    expect(result.sessionThread).toBe(sessionThread);
    expect(result.historyReset).toBe(false);
  });
});
