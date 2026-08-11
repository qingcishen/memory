import { describe, expect, it, vi } from 'vitest';
import { Memory } from '../src/memory.js';
import {
  WORKING_MEMORY_CONTEXT_MULTIPLIER,
  WORKING_MEMORY_TTL_MS,
  buildWorkingMemoryRecord,
  effectiveMemoryType,
  isFreshWorkingMemory,
  selectWorkingMemoryBridge,
  storeWorkingMemory,
  toWorkingMemoryRow,
} from '../src/memory/workingMemory.js';
import { scoreActivation } from '../src/engine/activation.js';
import {
  InMemoryConsolidationStore,
  consolidate,
} from '../src/existence/memoryConsolidation.js';
import { createMemoryPrivateMemoryStore } from '../src/existence/privateMemoryStore.js';
import {
  emptySessionThread,
  sessionThreadToPrompt,
  updateSessionThread,
} from '../src/companion/sessionThread.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { perceiveTurn } from '../src/orchestrator/perceive.js';
import { normalizeMemory } from '../src/ontology.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function workingAt(ageHours, overrides = {}) {
  return {
    id: `wm-${ageHours}`,
    type: 'working_memory',
    content: '她还记得对方明天要面试，心里有点惦记。',
    fact_core: '她还记得对方明天要面试，心里有点惦记。',
    subject_kind: 'user',
    importance: 4,
    emotion: 0.4,
    affect_valence: -0.1,
    affect_intensity: 0.4,
    similarity: 0.8,
    access_log: [],
    access_count: 0,
    created_at: new Date(NOW - ageHours * HOUR).toISOString(),
    last_accessed: new Date(NOW - ageHours * HOUR).toISOString(),
    ...overrides,
  };
}

describe('M-5 working-memory record contract', () => {
  it('builds a scoped 48h projection with stable event idempotency', () => {
    const input = {
      content: '还在想她说明天面试时那点紧张，希望她能睡稳一点。',
      emotional_valence: -0.25,
      idempotencyKey: 'silence:u1:c1:abc',
      createdAt: NOW,
    };
    const first = buildWorkingMemoryRecord(input);
    const replay = buildWorkingMemoryRecord(input);
    const other = buildWorkingMemoryRecord({
      ...input,
      idempotencyKey: 'silence:u1:c1:def',
    });

    expect(first).toMatchObject({
      type: 'working_memory',
      subject_kind: 'user',
      importance: 4,
      created_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + WORKING_MEMORY_TTL_MS).toISOString(),
    });
    expect(replay.idempotency_key).toBe(first.idempotency_key);
    expect(other.idempotency_key).not.toBe(first.idempotency_key);
    expect(normalizeMemory(first).type).toBe('working_memory');

    const row = toWorkingMemoryRow('u1', 'c1', first, [0.1, 0.2]);
    expect(row).toMatchObject({
      user_id: 'u1',
      companion_id: 'c1',
      type: 'working_memory',
      dedup_hash: first.idempotency_key,
      created_at: new Date(NOW).toISOString(),
      source: expect.objectContaining({
        lifecycle: '48h_bridge_then_episode',
        expires_at: new Date(NOW + WORKING_MEMORY_TTL_MS).toISOString(),
      }),
    });
  });

  it('stores through an injectable idempotent main-memory writer', async () => {
    const record = buildWorkingMemoryRecord({
      content: '还记得上次没说完的面试。',
      idempotencyKey: 'silence:evt-1',
      createdAt: NOW,
    });
    const insertFn = vi.fn(async (row) => ({ id: 'main-wm-1', ...row }));
    const rows = await storeWorkingMemory('u1', 'c1', record, {
      embedFn: vi.fn(async () => [0.3]),
      insertFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'main-wm-1',
      type: 'working_memory',
      subject_kind: 'user',
    });
  });

  it('Memory.observe uses a dedicated projection branch without dialogue extraction', async () => {
    const workingMemoryStore = vi.fn(async (_userId, _companionId, record) => [
      { id: 'wm-main', ...record },
    ]);
    const memory = new Memory({
      userId: 'u1',
      companionId: 'c1',
      workingMemoryStore,
    });

    const result = await memory.observe(
      [{ role: 'user', content: '这段原始对话不应由该支路再次提取' }],
      {
        workingMemory: {
          content: '上次聊到明天的面试，她仍然有些惦记。',
          emotional_valence: -0.2,
          idempotencyKey: 'silence:evt-observe',
          createdAt: NOW,
        },
        now: NOW,
      },
    );

    expect(workingMemoryStore).toHaveBeenCalledTimes(1);
    expect(result.stored).toHaveLength(1);
    expect(result.workingMemory).toMatchObject({
      type: 'working_memory',
      stored: true,
      deduplicated: false,
    });
    expect(result.beliefs).toEqual([]);
  });
});

describe('M-5 48h activation lifecycle', () => {
  const params = {
    forgetRate: 0.5,
    wCtx: 1,
    wSpread: 0,
    wMood: 0,
    wMile: 0,
    temporalPenalty: 0,
  };

  it('multiplies only the fresh working-memory context term by 1.3', () => {
    const fresh = workingAt(1);
    const ordinary = { ...fresh, id: 'episode', type: 'episode' };
    const [rankedFresh] = scoreActivation([fresh], {}, { now: NOW, params });
    const [rankedOrdinary] = scoreActivation([ordinary], {}, {
      now: NOW,
      params,
    });

    expect(rankedFresh._effectiveType).toBe('working_memory');
    expect(rankedFresh._act.ctxMultiplier).toBe(
      WORKING_MEMORY_CONTEXT_MULTIPLIER,
    );
    expect(
      rankedFresh._activation - rankedOrdinary._activation,
    ).toBeCloseTo(
      params.wCtx *
        fresh.similarity *
        (WORKING_MEMORY_CONTEXT_MULTIPLIER - 1),
      8,
    );
  });

  it('at 48h expires to ordinary episode scoring and no context bonus', () => {
    const expired = workingAt(48);
    const ordinary = { ...expired, id: 'episode', type: 'episode' };
    const withPenalty = { ...params, temporalPenalty: 0.8 };
    const [rankedExpired] = scoreActivation([expired], {}, {
      now: NOW,
      params: withPenalty,
    });
    const [rankedOrdinary] = scoreActivation([ordinary], {}, {
      now: NOW,
      params: withPenalty,
    });

    expect(isFreshWorkingMemory(expired, NOW)).toBe(false);
    expect(effectiveMemoryType(expired, NOW)).toBe('episode');
    expect(rankedExpired._effectiveType).toBe('episode');
    expect(rankedExpired._act.ctxMultiplier).toBe(1);
    expect(rankedExpired._act.tpen).toBe(rankedOrdinary._act.tpen);
    expect(rankedExpired._activation).toBeCloseTo(
      rankedOrdinary._activation,
      8,
    );
  });

  it('the bridge selects only fresh rows and newest first', () => {
    expect(
      selectWorkingMemoryBridge(
        [workingAt(49), workingAt(20), workingAt(2), { type: 'episode' }],
        { now: NOW, topK: 2 },
      ).map((memory) => memory.id),
    ).toEqual(['wm-2', 'wm-20']);
  });
});

describe('M-5 CEE and next-session integration', () => {
  function consolidationDeps(memory) {
    return {
      now: NOW,
      lastInteractionAt: NOW - 3 * HOUR,
      recentTurns: [
        {
          id: 'turn-u',
          role: 'user',
          content: '明天面试，有点紧张',
          created_at: new Date(NOW - 3 * HOUR).toISOString(),
        },
        {
          id: 'turn-a',
          role: 'assistant',
          content: '我知道，你已经准备得很认真了',
          created_at: new Date(NOW - 3 * HOUR + 60_000).toISOString(),
        },
      ],
      currentState: {},
      generateInnerMonologue: vi.fn(async () =>
        '还在想她说明天面试时那点紧张，希望她能睡稳一点。'
      ),
      privateMemoryStore: createMemoryPrivateMemoryStore(),
      consolidationStore: new InMemoryConsolidationStore(),
      memory,
    };
  }

  it('syncs silence consolidation into main Memory.observe as working_memory', async () => {
    const observe = vi.fn(async (_turns, opts) => ({
      stored: [{ id: 'wm-main', type: 'working_memory' }],
      workingMemory: { stored: true, deduplicated: false },
      received: opts,
    }));
    const deps = consolidationDeps({ observe });
    const result = await consolidate('u1', 'c1', deps);

    expect(result).toMatchObject({
      consolidated: true,
      workingMemory: {
        attempted: true,
        stored: true,
        reason: 'stored',
      },
    });
    expect(observe).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        workingMemoryOnly: true,
        autoForget: false,
        workingMemory: expect.objectContaining({
          content: expect.stringContaining('明天面试'),
          idempotencyKey: result.idempotencyKey,
        }),
      }),
    );
  });

  it('releases the claim and retries only the missing projection after a sync failure', async () => {
    const observe = vi
      .fn()
      .mockRejectedValueOnce(new Error('main memory unavailable'))
      .mockResolvedValueOnce({
        stored: [{ id: 'wm-main', type: 'working_memory' }],
        workingMemory: { stored: true, deduplicated: false },
      });
    const deps = consolidationDeps({ observe });

    const first = await consolidate('u1', 'c1', deps);
    const second = await consolidate('u1', 'c1', deps);
    const privateRows = await deps.privateMemoryStore.list({
      userId: 'u1',
      companionId: 'c1',
    });

    expect(first).toMatchObject({
      consolidated: false,
      reason: 'working_memory_sync_failed',
      privateMemoryStored: true,
    });
    expect(second).toMatchObject({
      consolidated: true,
      workingMemory: { stored: true },
    });
    expect(privateRows).toHaveLength(1);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it('new-session bridge prefers working memory and injects it on the first turn', async () => {
    const recallWorkingMemory = vi.fn(async () => [
      workingAt(2, {
        fact_core: '上次聊到她今天要面试，她仍然有些惦记。',
      }),
    ]);
    const recall = vi.fn(async () => ({
      hits: [{ type: 'episode', fact_core: '普通近期记忆' }],
    }));
    const bridge = await Orchestrator.prototype._buildCrossSessionBridge.call({
      userId: 'u1',
      memory: { recallWorkingMemory, recall },
      now: () => NOW,
    });

    expect(bridge).toContain('今天要面试');
    expect(recallWorkingMemory).toHaveBeenCalledWith({
      now: NOW,
      topK: 3,
    });
    expect(recall).not.toHaveBeenCalled();

    let thread = {
      ...emptySessionThread(NOW),
      crossSessionContext: bridge,
    };
    thread = updateSessionThread(thread, {
      userMessage: '早',
      reply: '早。',
      now: NOW + 1,
    });
    expect(sessionThreadToPrompt(thread)).toContain(
      '【上次记得】上次聊到她今天要面试',
    );
  });

  it('preserves a freshly loaded bridge through the real >=4h perceive reset', async () => {
    const sixHoursAgo = NOW - 6 * HOUR;
    const previousThread = {
      ...emptySessionThread(sixHoursAgo),
      turnCount: 5,
      updatedAt: sixHoursAgo,
      primaryTopic: '面试准备',
    };
    const historyStore = {
      loadSessionThread: vi.fn(async () => previousThread),
    };
    const recallWorkingMemory = vi.fn(async () => [
      workingAt(2, {
        fact_core: '上次聊到她今天要面试，她仍然有些惦记。',
      }),
    ]);
    const orchestratorLike = {
      userId: 'u1',
      companionId: 'c1',
      history: [
        {
          role: 'user',
          content: '明天面试，有点紧张',
          created_at: new Date(sixHoursAgo).toISOString(),
        },
      ],
      historyStore,
      memory: { recallWorkingMemory },
      now: () => NOW,
      _buildCrossSessionBridge: Orchestrator.prototype._buildCrossSessionBridge,
      _sessionThread: null,
    };

    // 真实加载路径先识别旧 thread，并用 working_memory 构建 turnCount=0 的新会话桥。
    const loaded = await Orchestrator.prototype.loadSessionThread.call(
      orchestratorLike,
    );
    expect(loaded.turnCount).toBe(0);
    expect(loaded.crossSessionContext).toContain('今天要面试');
    expect(historyStore.loadSessionThread).toHaveBeenCalledTimes(1);
    expect(recallWorkingMemory).toHaveBeenCalledTimes(1);

    // 首轮 perception 又因物理现场已过期而重置 history；桥必须穿过这次二次重置。
    const perceived = perceiveTurn({
      userMessage: '早',
      history: orchestratorLike.history,
      sessionThread: loaded,
      sessionThreadEnabled: true,
      lastUserMessageAt: sixHoursAgo,
      storedLastUserMessageAt: new Date(sixHoursAgo).toISOString(),
      now: NOW,
    });
    expect(perceived.historyReset).toBe(true);
    expect(perceived.sessionReset).toBe(true);
    expect(perceived.sessionThread.turnCount).toBe(0);
    expect(perceived.sessionThread.crossSessionContext).toContain('今天要面试');

    const firstTurnPeek = updateSessionThread(perceived.sessionThread, {
      userMessage: '早',
      reply: '',
      now: NOW,
    });
    expect(sessionThreadToPrompt(firstTurnPeek)).toContain(
      '【上次记得】上次聊到她今天要面试',
    );

    // 已消费过的 bridge 不能继续带进第三场会话。
    const laterReset = perceiveTurn({
      userMessage: '又过了一天',
      history: [{ role: 'assistant', content: '早。' }],
      sessionThread: {
        ...firstTurnPeek,
        turnCount: 3,
        updatedAt: sixHoursAgo,
      },
      lastUserMessageAt: sixHoursAgo,
      now: NOW,
    });
    expect(laterReset.sessionThread.crossSessionContext).toBeNull();
  });

  it('Orchestrator centrally binds the production CEE to its MemoryAdapter', () => {
    const existence = { memory: null };
    const orchestrator = new Orchestrator({
      userId: 'u-bind',
      deps: {
        existence,
        stateLayer: {},
        relationship: {},
        persona: {},
        llm: {},
      },
    });

    expect(orchestrator.memory.constructor.name).toBe('MemoryAdapter');
    expect(orchestrator.memory._mem).toBeInstanceOf(Memory);
    expect(existence.memory).toBe(orchestrator.memory);
  });
});
