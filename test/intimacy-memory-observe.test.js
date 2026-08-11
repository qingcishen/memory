import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/extract.js', () => ({
  extractMemories: vi.fn(async () => []),
  applyMoodShiftBoost: vi.fn((memories) => memories),
}));

vi.mock('../src/store.js', () => ({
  storeMemories: vi.fn(async () => []),
}));

vi.mock('../src/state/affect.js', () => ({
  readState: vi.fn(async () => ({
    relationship: {
      closeness: 0.8,
      trust: 0.8,
      tension: 0,
      repair_debt: 0,
    },
  })),
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

const { Memory } = await import('../src/memory.js');

describe('Memory.observe owns authoritative intimacy before/after', () => {
  let intimateMemoryStore;

  beforeEach(() => {
    intimateMemoryStore = vi.fn(async (_userId, _companionId, record) => [
      { id: 'm-intimate', ...record },
    ]);
  });

  it('records the transition returned by the shared IntimacyDimension without dialogue text', async () => {
    const explicitDialogue = '原始显式正文不能进入亲密记忆';
    const intimacy = {
      snapshot: vi.fn(async () => ({
        scene_phase: 'foreplay',
        last_intimate_at: '2026-07-29T10:00:00.000Z',
      })),
      evolve: vi.fn(async () => ({
        scene_phase: 'peak',
        last_intimate_at: '2026-07-29T10:01:00.000Z',
        consent: { active: true },
        _meta: {},
      })),
    };
    const memory = new Memory({
      userId: 'u1',
      companionId: 'c1',
      intimateMemoryStore,
    });

    const result = await memory.observe(
      [
        { role: 'user', content: explicitDialogue },
        { role: 'assistant', content: '同样不应保存的回复正文' },
      ],
      {
        intimacy,
        eventId: 'evt-peak',
        now: Date.parse('2026-07-29T10:01:00.000Z'),
        prospective: false,
        knowledge: false,
        useLLM: false,
      },
    );

    expect(intimacy.snapshot).toHaveBeenCalledTimes(1);
    expect(intimacy.evolve).toHaveBeenCalledTimes(1);
    expect(intimateMemoryStore).toHaveBeenCalledTimes(1);
    const record = intimateMemoryStore.mock.calls[0][2];
    expect(record.transition).toEqual({ from: 'foreplay', to: 'peak' });
    expect(JSON.stringify(record)).not.toContain(explicitDialogue);
    expect(result.intimateMemory).toEqual({
      transition: { from: 'foreplay', to: 'peak' },
      stored: true,
      deduplicated: false,
      failed: false,
    });
    expect(result.stored[0]).toMatchObject({
      id: 'm-intimate',
      type: 'intimate_memory',
      subject_kind: 'dyad',
    });
  });

  it('does not record when authoritative before and after remain in the same phase', async () => {
    const intimacy = {
      snapshot: vi.fn(async () => ({ scene_phase: 'peak' })),
      evolve: vi.fn(async () => ({ scene_phase: 'peak', _meta: {} })),
    };
    const memory = new Memory({ userId: 'u1', intimateMemoryStore });

    const result = await memory.observe([], {
      intimacy,
      eventId: 'evt-replay',
      prospective: false,
      knowledge: false,
      useLLM: false,
    });

    expect(intimateMemoryStore).not.toHaveBeenCalled();
    expect(result.intimateMemory).toBeNull();
  });
});
