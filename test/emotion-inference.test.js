import { describe, expect, it, vi } from 'vitest';
import {
  consumeLLMEmotionInference,
  emotionHeuristicConfidence,
  inferEmotionLabel,
  shouldLLMInfer,
  startLLMEmotionInference,
} from '../src/state/emotionLabel.js';

const IMPLICIT_LONG_TEXT =
  '你最近回复的方式和以前有一点不一样，我也说不清到底是哪里变了';

describe('E-3 low-confidence trigger contract', () => {
  it('marks explicit emotion evidence high-confidence and implicit long text low-confidence', () => {
    expect(emotionHeuristicConfidence('我真的很生气，这件事太过分了', '生气')).toBe(0.9);
    expect(emotionHeuristicConfidence(IMPLICIT_LONG_TEXT, '平静')).toBeLessThan(0.5);
    expect(emotionHeuristicConfidence('晚安', '平静')).toBeGreaterThanOrEqual(0.5);
  });

  it('triggers only for low confidence and at most once every three turns', () => {
    expect(
      shouldLLMInfer(IMPLICIT_LONG_TEXT, {
        confidence: 0.35,
        currentTurn: 1,
        lastInferTurn: null,
      }),
    ).toBe(true);
    expect(
      shouldLLMInfer(IMPLICIT_LONG_TEXT, {
        confidence: 0.35,
        currentTurn: 3,
        lastInferTurn: 1,
      }),
    ).toBe(false);
    expect(
      shouldLLMInfer(IMPLICIT_LONG_TEXT, {
        confidence: 0.35,
        currentTurn: 4,
        lastInferTurn: 1,
      }),
    ).toBe(true);
    expect(
      shouldLLMInfer(IMPLICIT_LONG_TEXT, {
        confidence: 0.7,
        currentTurn: 4,
        lastInferTurn: 1,
      }),
    ).toBe(false);
    expect(
      shouldLLMInfer(IMPLICIT_LONG_TEXT, {
        confidence: 0.35,
        currentTurn: 4,
        lastInferTurn: 1,
        pending: true,
      }),
    ).toBe(false);
    expect(
      shouldLLMInfer('这句不够长', {
        confidence: 0.2,
        currentTurn: 9,
      }),
    ).toBe(false);
  });

  it('exposes the heuristic confidence through the normal inferred result', () => {
    const result = inferEmotionLabel(
      { emotion: { valence: 0 }, relationship: { closeness: 0.5 } },
      {},
      [{ role: 'user', content: IMPLICIT_LONG_TEXT }],
      {
        userMessage: IMPLICIT_LONG_TEXT,
        previousResidual: null,
        withResidual: true,
      },
    );
    expect(result.label).toBe('平静');
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('E-3 asynchronous result handoff', () => {
  it('does not block while pending and consumes the settled result on a later turn', async () => {
    let resolveCall;
    const llmCall = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );
    const task = startLLMEmotionInference(IMPLICIT_LONG_TEXT, llmCall, {
      sourceTurn: 1,
    });

    expect(
      consumeLLMEmotionInference(task, { currentTurn: 2 }),
    ).toMatchObject({ label: null, task, consumed: false });

    resolveCall('担心');
    await task.promise;

    expect(
      consumeLLMEmotionInference(task, { currentTurn: 3 }),
    ).toEqual({ label: '担心', task: null, consumed: true });
  });

  it('expires a hung request so later turns can retry', () => {
    const task = startLLMEmotionInference(
      IMPLICIT_LONG_TEXT,
      () => new Promise(() => {}),
      { sourceTurn: 2 },
    );
    expect(
      consumeLLMEmotionInference(task, {
        currentTurn: 5,
        maxPendingTurns: 3,
      }),
    ).toEqual({
      label: null,
      task: null,
      consumed: false,
      expired: true,
    });
  });

  it('settles invalid or failed classifications without leaking a rejection', async () => {
    const invalid = startLLMEmotionInference(
      IMPLICIT_LONG_TEXT,
      async () => '不是合法标签',
      { sourceTurn: 1 },
    );
    await expect(invalid.promise).resolves.toBeNull();
    expect(consumeLLMEmotionInference(invalid, { currentTurn: 2 })).toEqual({
      label: null,
      task: null,
      consumed: true,
    });

    const failed = startLLMEmotionInference(
      IMPLICIT_LONG_TEXT,
      async () => {
        throw new Error('temporary failure');
      },
      { sourceTurn: 4 },
    );
    await expect(failed.promise).resolves.toBeNull();
  });
});
