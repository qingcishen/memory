import { describe, expect, it, vi } from 'vitest';
import {
  emptySessionThread,
  normalizeSessionThread,
  serializeSessionThread,
} from '../src/companion/sessionThread.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';

const BASE_NOW = Date.parse('2026-07-29T12:00:00.000Z');
const LOW_CONFIDENCE_TEXT =
  '你最近回复的方式和以前有一点不一样，我也说不清到底是哪里变了';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createSharedHistoryStore() {
  const state = {
    rows: [],
    thread: null,
  };
  return {
    state,
    async load() {
      return clone(state.rows);
    },
    async append({ turns }) {
      state.rows.push(...clone(turns));
    },
    async lastUserMessageAt() {
      return null;
    },
    async loadSessionThread() {
      return clone(state.thread);
    },
    async saveSessionThread({ thread }) {
      state.thread = clone(thread);
      return true;
    },
  };
}

function createUiProcessDeps({ historyStore, classifyEmotion, now }) {
  return {
    now: () => now,
    historyStore,
    memory: {
      async recall() {
        return { block: '', hits: [] };
      },
      async observe() {},
    },
    stateLayer: {
      async snapshot() {
        return {
          emotion: { valence: 0, warmth: 0.5 },
          mood: { valence: 0, arousal: 0.3 },
          relationship: { closeness: 0.6, trust: 0.6, tension: 0 },
          life: { energy: 0.8, health: 1, satiety: 0.6 },
          desires: {},
        };
      },
      async evolve() {},
      toPrompt() {
        return '';
      },
      samplingHints() {
        return { temperature: 0.7, maxTokens: 120 };
      },
    },
    relationship: {
      async current() {
        return {
          relationship: {
            closeness: 0.6,
            trust: 0.6,
            tension: 0,
            repair_debt: 0,
          },
        };
      },
      async bump() {},
      toPrompt() {
        return '';
      },
    },
    persona: {
      async load() {},
      toPrompt() {
        return '自然回应。';
      },
    },
    llm: {
      classifyEmotion,
      async generateReply() {
        return {
          text: '我在听。',
          parts: [{ type: 'dialogue', text: '我在听。' }],
        };
      },
    },
  };
}

async function runFreshUiTurn({
  historyStore,
  classifyEmotion,
  now,
  eventId,
  settleTimeoutMs = 100,
}) {
  // chat-runner 的关键生命周期：每条消息都构造一个全新的 Orchestrator，
  // 回复送出后再有界等待 E-3 和 SessionThread 落盘。
  const orchestrator = new Orchestrator({
    userId: 'ui:e3-cold-start',
    deps: createUiProcessDeps({ historyStore, classifyEmotion, now }),
    options: { useMonologue: false },
  });
  const result = await orchestrator.reply(LOW_CONFIDENCE_TEXT, {
    eventId,
    skipCoherenceRetry: true,
  });
  await orchestrator._lastAfterReply?.catch(() => {});
  await orchestrator.waitForEmotionInference({ timeoutMs: settleTimeoutMs });
  await orchestrator._lastSessionPersist?.catch(() => {});
  return { orchestrator, result };
}

describe('E-3 SessionThread persistence across UI cold starts', () => {
  it('round-trips the JSON-only throttle cursor and settled label compatibly', () => {
    const legacy = normalizeSessionThread({
      ...emptySessionThread(BASE_NOW),
      turnCount: 2,
    });
    expect(legacy.emotionInference).toEqual({
      lastInferTurn: null,
      readyLabel: null,
      readySourceTurn: null,
    });

    const restored = normalizeSessionThread(
      JSON.parse(
        JSON.stringify(
          serializeSessionThread({
            ...legacy,
            emotionInference: {
              lastInferTurn: 1,
              readyLabel: '担心',
              readySourceTurn: 1,
            },
          }),
        ),
      ),
      BASE_NOW,
    );
    expect(restored.emotionInference).toEqual({
      lastInferTurn: 1,
      readyLabel: '担心',
      readySourceTurn: 1,
    });
    expect(JSON.stringify(restored)).not.toContain('promise');
  });

  it('consumes a completed result in the next fresh process and throttles for three turns', async () => {
    const historyStore = createSharedHistoryStore();
    const labels = ['担心', '失落'];
    const classifyEmotion = vi.fn(async () => labels.shift() ?? '平静');

    const first = await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW,
      eventId: 'e3-ui-1',
    });
    expect(first.result.emotionLabel).toBe('平静');
    expect(classifyEmotion).toHaveBeenCalledTimes(1);
    expect(historyStore.state.thread.emotionInference).toEqual({
      lastInferTurn: 1,
      readyLabel: '担心',
      readySourceTurn: 1,
    });

    const second = await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW + 60_000,
      eventId: 'e3-ui-2',
    });
    expect(second.result.emotionLabel).toBe('担心');
    expect(classifyEmotion).toHaveBeenCalledTimes(1);
    expect(historyStore.state.thread.emotionInference).toEqual({
      lastInferTurn: 1,
      readyLabel: null,
      readySourceTurn: null,
    });

    await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW + 2 * 60_000,
      eventId: 'e3-ui-3',
    });
    expect(classifyEmotion).toHaveBeenCalledTimes(1);

    await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW + 3 * 60_000,
      eventId: 'e3-ui-4',
    });
    expect(classifyEmotion).toHaveBeenCalledTimes(2);
    expect(historyStore.state.thread.emotionInference).toEqual({
      lastInferTurn: 4,
      readyLabel: '失落',
      readySourceTurn: 4,
    });
  });

  it('keeps the persisted throttle when a short-lived process times out', async () => {
    const historyStore = createSharedHistoryStore();
    const classifyEmotion = vi.fn(() => new Promise(() => {}));

    await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW,
      eventId: 'e3-timeout-1',
      settleTimeoutMs: 5,
    });
    expect(classifyEmotion).toHaveBeenCalledTimes(1);
    expect(historyStore.state.thread.emotionInference).toEqual({
      lastInferTurn: 1,
      readyLabel: null,
      readySourceTurn: null,
    });

    await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW + 60_000,
      eventId: 'e3-timeout-2',
      settleTimeoutMs: 5,
    });
    await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW + 2 * 60_000,
      eventId: 'e3-timeout-3',
      settleTimeoutMs: 5,
    });
    expect(classifyEmotion).toHaveBeenCalledTimes(1);

    await runFreshUiTurn({
      historyStore,
      classifyEmotion,
      now: BASE_NOW + 3 * 60_000,
      eventId: 'e3-timeout-4',
      settleTimeoutMs: 5,
    });
    expect(classifyEmotion).toHaveBeenCalledTimes(2);
  });
});
