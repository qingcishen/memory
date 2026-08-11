import { describe, expect, it } from 'vitest';
import { emptySessionThread } from '../src/companion/sessionThread.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { defaultIntimacy } from '../src/state/intimacy.js';
import { INTIMACY_BEAT_TEMPLATES } from '../src/state/intimacyScript.js';

const BASE_NOW = Date.parse('2026-07-29T09:00:00.000Z');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createHistoryStore(initialThread = null) {
  const state = {
    rows: [],
    thread: clone(initialThread),
    savedThreads: [],
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
      state.savedThreads.push(clone(thread));
      return true;
    },
  };
}

function intimacySnapshot(phase) {
  const active = ['flirting', 'foreplay', 'peak', 'aftercare'].includes(phase);
  return {
    ...defaultIntimacy(),
    scene_phase: phase,
    arousal: phase === 'none' ? 0.2 : 0.72,
    engagement: active ? 0.75 : 0.3,
    sexual_tension: phase === 'none' ? 0.2 : 0.76,
    sexual_openness: 0.9,
    satisfaction: 0.6,
    body_focus: { primary: 'mouth' },
    consent: {
      active,
      pace: 'normal',
      stop_signal: false,
      stop_at: null,
    },
  };
}

function createDependencies({
  phase = 'foreplay',
  sceneType = 'intimate',
  historyStore = createHistoryStore(),
} = {}) {
  const control = {
    phase,
    sceneType,
    now: BASE_NOW,
    failGeneration: false,
  };
  const normalCalls = [];
  const streamCalls = [];
  let replySequence = 0;

  const relationshipState = {
    closeness: 0.92,
    trust: 0.92,
    tension: 0.05,
    repair_debt: 0,
  };

  const deps = {
    now: () => control.now,
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
          emotion: { valence: 0.3, warmth: 0.8 },
          mood: { valence: 0.3, arousal: 0.4 },
          relationship: relationshipState,
          life: { energy: 0.9, health: 1, satiety: 0.6 },
          desires: {},
          intimacy: intimacySnapshot(control.phase),
        };
      },
      async evolve() {},
      toPrompt() {
        return '状态稳定';
      },
      samplingHints() {
        return { temperature: 0.7, maxTokens: 320 };
      },
    },
    relationship: {
      async current() {
        return { relationship: relationshipState };
      },
      async bump() {},
      toPrompt() {
        return '关系亲近且彼此信任';
      },
    },
    persona: {
      async load() {},
      toPrompt() {
        return '自然、尊重边界、回应当下。';
      },
    },
    narration: {
      async classify() {
        return control.sceneType;
      },
    },
    llm: {
      async generateReply(messages, opts) {
        normalCalls.push({ messages: clone(messages), opts: clone(opts) });
        if (control.failGeneration) throw new Error('mock generation failed');
        replySequence += 1;
        return {
          text: `普通回应${replySequence}`,
          parts: [{ type: 'dialogue', text: `普通回应${replySequence}` }],
        };
      },
      async *generateReplyStream(messages, opts) {
        streamCalls.push({ messages: clone(messages), opts: clone(opts) });
        if (control.failGeneration) throw new Error('mock stream failed');
        replySequence += 1;
        const text = `流式回应${replySequence}`;
        yield { event: 'preview', text };
        yield {
          event: 'done',
          text,
          parts: [{ type: 'dialogue', text }],
          streamed: true,
        };
      },
    },
  };

  return { deps, control, historyStore, normalCalls, streamCalls };
}

function systemPrompt(call) {
  return call.messages.find((message) => message.role === 'system')?.content ?? '';
}

function expectBeat(prompt, phase, index) {
  expect(prompt).toContain('【本轮亲密叙事节拍】');
  expect(prompt).toContain(INTIMACY_BEAT_TEMPLATES[phase][index].scene_beat);
}

describe('I-5 real Orchestrator integration', () => {
  it('advances a normal reply and resumes the next beat after a cold start', async () => {
    const setup = createDependencies();
    const first = new Orchestrator({
      userId: 'beat-cold-start',
      deps: setup.deps,
      options: { useMonologue: false },
    });

    await first.reply('继续亲我', {
      eventId: 'beat-normal-1',
      skipCoherenceRetry: true,
    });
    await first._lastSessionPersist;

    expectBeat(systemPrompt(setup.normalCalls[0]), 'foreplay', 0);
    expect(setup.historyStore.state.thread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 1,
    });

    setup.control.now += 60_000;
    const restarted = new Orchestrator({
      userId: 'beat-cold-start',
      deps: setup.deps,
      options: { useMonologue: false },
    });
    await restarted.reply('还是这个动作', {
      eventId: 'beat-normal-2',
      skipCoherenceRetry: true,
    });
    await restarted._lastSessionPersist;

    expectBeat(systemPrompt(setup.normalCalls[1]), 'foreplay', 1);
    expect(setup.historyStore.state.thread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 2,
    });
  });

  it('uses the same commit-time cursor contract on the streaming path', async () => {
    const setup = createDependencies();
    const orchestrator = new Orchestrator({
      userId: 'beat-stream',
      deps: setup.deps,
      options: { useMonologue: false },
    });
    const events = [];

    for await (const event of orchestrator.replyStream('继续亲我', {
      eventId: 'beat-stream-1',
      skipCoherenceRetry: true,
    })) {
      events.push(event);
    }
    await orchestrator._lastSessionPersist;

    expect(events.some((event) => event.event === 'done')).toBe(true);
    expectBeat(systemPrompt(setup.streamCalls[0]), 'foreplay', 0);
    expect(setup.historyStore.state.thread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 1,
    });
  });

  it('starts at zero on a phase change and clears the cursor after leaving intimacy', async () => {
    const setup = createDependencies();
    const orchestrator = new Orchestrator({
      userId: 'beat-phase-switch',
      deps: setup.deps,
      options: { useMonologue: false },
    });

    await orchestrator.reply('继续亲我', {
      eventId: 'beat-phase-1',
      skipCoherenceRetry: true,
    });
    setup.control.phase = 'peak';
    setup.control.now += 60_000;
    await orchestrator.reply('继续', {
      eventId: 'beat-phase-2',
      skipCoherenceRetry: true,
    });

    expectBeat(systemPrompt(setup.normalCalls[1]), 'peak', 0);
    expect(setup.historyStore.state.thread.intimacyBeat).toEqual({
      phase: 'peak',
      nextIndex: 1,
    });

    setup.control.phase = 'none';
    setup.control.sceneType = 'daily';
    setup.control.now += 60_000;
    await orchestrator.reply('今天吃什么', {
      eventId: 'beat-phase-3',
      skipCoherenceRetry: true,
    });
    await orchestrator._lastSessionPersist;

    expect(systemPrompt(setup.normalCalls[2])).not.toContain('【本轮亲密叙事节拍】');
    expect(setup.historyStore.state.thread.intimacyBeat).toEqual({
      phase: null,
      nextIndex: 0,
    });
  });

  it('does not consume the prepared beat when generation fails before Commit', async () => {
    const initialThread = {
      ...emptySessionThread(BASE_NOW),
      turnCount: 2,
      updatedAt: BASE_NOW,
      intimacyBeat: { phase: 'foreplay', nextIndex: 2 },
    };
    const historyStore = createHistoryStore(initialThread);
    const setup = createDependencies({ historyStore });
    setup.control.failGeneration = true;
    const orchestrator = new Orchestrator({
      userId: 'beat-generation-failure',
      deps: setup.deps,
      options: { useMonologue: false },
    });

    await expect(
      orchestrator.reply('继续亲我', {
        eventId: 'beat-failed-generation',
        skipCoherenceRetry: true,
      }),
    ).rejects.toThrow('mock generation failed');

    expectBeat(systemPrompt(setup.normalCalls[0]), 'foreplay', 2);
    expect(historyStore.state.savedThreads).toHaveLength(0);
    expect(historyStore.state.thread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 2,
    });
    expect(orchestrator._sessionThread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 2,
    });
  });

  it('does not advance twice when the full reply path replays the same event id', async () => {
    const setup = createDependencies();
    const orchestrator = new Orchestrator({
      userId: 'beat-idempotent-replay',
      deps: setup.deps,
      options: { useMonologue: false },
    });
    const options = {
      eventId: 'beat-replayed-event',
      skipCoherenceRetry: true,
    };

    await orchestrator.reply('继续亲我', options);
    await orchestrator._lastSessionPersist;
    await orchestrator.reply('继续亲我', options);

    expectBeat(systemPrompt(setup.normalCalls[0]), 'foreplay', 0);
    // Replay can prepare the next prompt, but the duplicate Commit must not consume it.
    expectBeat(systemPrompt(setup.normalCalls[1]), 'foreplay', 1);
    expect(setup.historyStore.state.savedThreads).toHaveLength(1);
    expect(setup.historyStore.state.thread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 1,
    });
  });
});
