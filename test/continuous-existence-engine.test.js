import { describe, expect, it, vi } from 'vitest';
import {
  createExistenceEngine,
  createMemoryContinuousStateStore,
  createMemoryPersonalityStore,
  createMemoryPrivateMemoryStore,
  defaultContinuousState,
} from '../src/existence/index.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function stateAt(lastInteraction = NOW) {
  const state = defaultContinuousState(lastInteraction);
  state.temporal.last_interaction = new Date(lastInteraction).toISOString();
  state.updated_at = new Date(lastInteraction).toISOString();
  return state;
}

function engineWithState(state, options = {}) {
  const stateStore = createMemoryContinuousStateStore({
    initial: [{ userId: 'u1', companionId: 'c1', state }],
    clock: () => NOW,
  });
  const privateMemoryStore = createMemoryPrivateMemoryStore();
  const engine = createExistenceEngine({
    userId: 'u1',
    companionId: 'c1',
    stateStore,
    privateMemoryStore,
    personalityStore: createMemoryPersonalityStore(),
    clock: () => NOW,
    ...options,
  });
  return { engine, stateStore, privateMemoryStore };
}

describe('ContinuousExistenceEngine integration facade', () => {
  it('dead-reckons a driving gap and compiles all prompt layers', async () => {
    const { engine } = engineWithState(stateAt(NOW - 30 * 60_000));
    const temporal = await engine.perceive({ now: NOW, activity: 'driving' });
    const turn = await engine.contextForTurn({
      now: NOW,
      temporalContext: temporal,
      relationship: { closeness: 0.82, trust: 0.8 },
      situation: 'default',
    });

    expect(temporal.elapsed_minutes).toBe(30);
    expect(temporal.inferences[0]).toMatchObject({
      type: 'activity_likely_completed',
      activity: 'driving',
    });
    expect(turn.temporalPrompt).toContain('开车');
    expect(turn.temporalPrompt).not.toContain('这么快');
    expect(turn.personalityPrompt).toContain('五层人格');
    expect(turn.continuousStatePrompt).toContain('持续内部状态');
  });

  it('commits the real interaction boundary and predicts the next message', async () => {
    const historyStore = {
      recentMessages: vi.fn(async () => [
        { role: 'user', created_at: '2026-07-27T12:00:00Z', content: 'a' },
        { role: 'user', created_at: '2026-07-28T12:00:00Z', content: 'b' },
        { role: 'user', created_at: '2026-07-29T11:00:00Z', content: 'c' },
      ]),
    };
    const { engine } = engineWithState(stateAt(NOW - 30 * 60_000), {
      historyStore,
    });
    const temporal = await engine.perceive({ now: NOW, activity: 'driving' });
    const turn = await engine.contextForTurn({
      now: NOW,
      temporalContext: temporal,
      unfinishedTopics: [{ summary: '到家后报平安' }],
    });
    await engine.observeTurn({
      eventId: 'evt-1',
      now: NOW,
      userMessage: '到家了',
      reply: '嗯，平安到就好。',
      temporalContext: temporal,
      turn,
      psychologicalCoherence: { score: 0.88 },
    });

    const saved = await engine.loadState();
    expect(saved.temporal.last_interaction).toBe(new Date(NOW).toISOString());
    expect(saved.temporal.expected_next).toBeTruthy();
    expect(saved.volitional.contact_inhibit).toBeGreaterThanOrEqual(0.65);
    expect(saved.cognitive.attention_focus).toBe('到家了');
    expect(saved.self.coherence_score).toBe(0.88);
  });

  it('rebases a slow turn on the latest heartbeat state before commit', async () => {
    const { engine, stateStore } = engineWithState(
      stateAt(NOW - 30 * 60_000),
    );
    const temporal = await engine.perceive({ now: NOW });
    const turn = await engine.contextForTurn({
      now: NOW,
      temporalContext: temporal,
      unfinishedTopics: [{ summary: '到家后报平安' }],
    });

    const heartbeatState = await engine.loadState();
    heartbeatState.cognitive.memory_surfaced = {
      id: 'private-1',
      summary: '回复生成时刚固化的念头',
    };
    heartbeatState.cognitive.active_thoughts = [
      { content: '回复生成时刚固化的念头', recurrence_count: 1 },
    ];
    heartbeatState.volitional.contact_inhibit = 0.9;
    await stateStore.save(heartbeatState, {
      userId: 'u1',
      companionId: 'c1',
    });

    await engine.observeTurn({
      eventId: 'evt-race',
      now: NOW,
      userMessage: '到了',
      reply: '平安就好。',
      temporalContext: temporal,
      turn,
    });

    const saved = await engine.loadState();
    expect(saved.cognitive.memory_surfaced?.id).toBe('private-1');
    expect(saved.cognitive.active_thoughts[0]?.content).toContain('刚固化');
    expect(saved.cognitive.unfinished_topics[0]?.summary).toBe('到家后报平安');
    expect(saved.volitional.contact_inhibit).toBe(0.9);
  });

  it('lets concrete inner drive through while retaining scheduler-facing decision shape', async () => {
    const state = stateAt(NOW - 4 * 60 * 60_000);
    state.volitional.proactive_desire = 0.9;
    state.cognitive.unfinished_topics = [{ summary: '问问面试结果', weight: 0.9 }];
    const historyStore = {
      recentMessages: vi.fn(async () => [
        { role: 'user', created_at: '2026-07-26T12:00:00Z', content: 'a' },
        { role: 'user', created_at: '2026-07-27T12:10:00Z', content: 'b' },
        { role: 'user', created_at: '2026-07-28T12:05:00Z', content: 'c' },
        { role: 'user', created_at: '2026-07-29T11:50:00Z', content: 'd' },
      ]),
      countMessagesSince: vi.fn(async () => 0),
    };
    const { engine } = engineWithState(state, { historyStore });
    engine.lastActivity = 'idle';

    const decision = await engine.decideContact({ now: NOW });
    expect(decision).toMatchObject({
      contact: true,
      reason: { type: 'unfinished_topic', content: '问问面试结果' },
    });
    expect(decision.receptivity.score).toBeGreaterThanOrEqual(0.3);
    expect(decision.coherence.desire_threshold).toBeGreaterThanOrEqual(0.4);
  });

  it('raises the proactive threshold when the current relationship is tense', async () => {
    const state = stateAt(NOW - 4 * 60 * 60_000);
    state.volitional.proactive_desire = 0.45;
    state.cognitive.unfinished_topics = [{ summary: '问问面试结果', weight: 0.9 }];
    const historyStore = {
      recentMessages: vi.fn(async () => [
        { role: 'user', created_at: '2026-07-26T12:00:00Z', content: 'a' },
        { role: 'user', created_at: '2026-07-27T12:10:00Z', content: 'b' },
        { role: 'user', created_at: '2026-07-28T12:05:00Z', content: 'c' },
        { role: 'user', created_at: '2026-07-29T11:50:00Z', content: 'd' },
      ]),
      countMessagesSince: vi.fn(async () => 0),
    };
    const { engine } = engineWithState(state, { historyStore });
    engine.lastActivity = 'idle';

    const relaxed = await engine.decideContact({ now: NOW });
    const tense = await engine.decideContact({
      now: NOW,
      relationship: { tension: 1 },
    });
    expect(relaxed.contact).toBe(true);
    expect(tense.contact).toBe(false);
    expect(tense.reason).toBe('desire_insufficient');
    expect(tense.coherence.desire_threshold).toBeGreaterThan(
      relaxed.coherence.desire_threshold,
    );
  });

  it('consolidates a two-hour silence into private memory exactly once', async () => {
    const state = stateAt(NOW - 3 * 60 * 60_000);
    const historyStore = {
      load: vi.fn(async () => [
        {
          id: 't1',
          role: 'user',
          content: '明天面试，有点紧张',
          created_at: new Date(NOW - 3.5 * 60 * 60_000).toISOString(),
        },
        {
          id: 't2',
          role: 'assistant',
          content: '我知道，你已经准备得很认真了',
          created_at: new Date(NOW - 3.4 * 60 * 60_000).toISOString(),
        },
      ]),
    };
    const llm = {
      think: vi.fn(async () => '还在想她说明天面试时那点紧张，希望她能睡稳一点。'),
    };
    const { engine, privateMemoryStore } = engineWithState(state, {
      historyStore,
      llm,
    });

    const first = await engine.heartbeat({ now: NOW });
    const second = await engine.heartbeat({ now: NOW + 30_000 });
    const memories = await privateMemoryStore.list({
      userId: 'u1',
      companionId: 'c1',
    });
    expect(first.consolidation.consolidated).toBe(true);
    expect(second.consolidation.reason).toBe('already_consolidated');
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      created_during_silence: true,
      metadata: expect.objectContaining({ visibility: 'private' }),
    });
    expect((await engine.loadState()).cognitive.memory_surfaced.summary).toContain(
      '明天面试',
    );
  });

  it('uses the self model to reconcile an explicit identity conflict', async () => {
    const llm = {
      think: vi.fn(async () => '说不担心是假的，你回来就好。'),
    };
    const { engine } = engineWithState(stateAt(NOW), {
      llm,
      personalitySeed: {
        self_model: {
          identity_narrative: ['我是那种很在意身边人的人'],
          identity_anchors: ['我会关心我认定的人'],
        },
      },
    });

    const result = await engine.checkCoherence('我根本不在乎你。');
    expect(result.coherent).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.reconciled_response).toBe('说不担心是假的，你回来就好。');
  });
});
