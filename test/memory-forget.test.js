import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/extract.js', () => ({
  extractMemories: vi.fn(async () => []),
  applyMoodShiftBoost: vi.fn((memories) => memories),
}));

vi.mock('../src/store.js', () => ({
  storeMemories: vi.fn(async () => []),
}));

vi.mock('../src/state/affect.js', () => ({
  readState: vi.fn(async () => null),
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

import {
  isAutoForgetProtected,
  lastMemoryAccessAt,
  selectAutoForgettable,
  shouldTriggerAutoForget,
} from '../src/reflect.js';

const { Memory } = await import('../src/memory.js');
const { Orchestrator } = await import('../src/orchestrator/index.js');

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function staleMemory(overrides = {}) {
  const accessedAt = new Date(NOW - 90 * DAY).toISOString();
  return {
    id: 'forgettable',
    type: 'episode',
    subject_kind: 'user',
    fact_locked: false,
    importance: 1,
    emotion: 0,
    access_count: 0,
    access_log: [accessedAt],
    created_at: accessedAt,
    last_accessed: accessedAt,
    ...overrides,
  };
}

describe('M-4 automatic forgetting pure contract', () => {
  it('clears the exact 90d boundary for every unprotected importance<3 row', () => {
    const eligibleImportance1 = staleMemory();
    const eligibleImportance2 = staleMemory({
      id: 'forgettable-importance-2',
      importance: 2,
    });
    const recent = staleMemory({
      id: 'recent',
      last_accessed: new Date(NOW - 89 * DAY).toISOString(),
      access_log: [],
    });
    const important = staleMemory({ id: 'important', importance: 3 });
    const emotionallyStrong = staleMemory({
      id: 'strong',
      importance: 2,
      emotion: 1,
    });
    const frequentlyRecalled = staleMemory({
      id: 'frequent',
      access_count: 30,
      access_log: Array.from(
        { length: 30 },
        (_, index) => new Date(NOW - (90 + index) * DAY).toISOString(),
      ),
    });

    expect(
      selectAutoForgettable(
        [
          eligibleImportance1,
          eligibleImportance2,
          recent,
          important,
          emotionallyStrong,
          frequentlyRecalled,
        ],
        { now: NOW, threshold: 0.1, baseLevelThreshold: 0.03 },
      ).map((memory) => memory.id),
    ).toEqual(['forgettable', 'forgettable-importance-2']);
  });

  it('uses the newest reliable access timestamp and keeps uncertain rows', () => {
    const old = new Date(NOW - 365 * DAY).toISOString();
    const fresh = new Date(NOW - 2 * DAY).toISOString();
    const inconsistent = staleMemory({
      id: 'inconsistent',
      last_accessed: old,
      access_log: [old, fresh],
    });
    const noTimestamp = staleMemory({
      id: 'unknown-time',
      last_accessed: null,
      access_log: [],
      created_at: null,
    });

    expect(lastMemoryAccessAt(inconsistent)).toBe(Date.parse(fresh));
    expect(lastMemoryAccessAt(noTimestamp)).toBeNull();
    expect(
      selectAutoForgettable([inconsistent, noTimestamp], { now: NOW }),
    ).toEqual([]);
  });

  it('hard-protects locked, dyad, relationship, and private event memories', () => {
    const protectedRows = [
      staleMemory({ id: 'locked', fact_locked: true }),
      staleMemory({ id: 'dyad', subject_kind: 'dyad' }),
      staleMemory({ id: 'relationship', type: 'relationship' }),
      staleMemory({ id: 'intimate', type: 'intimate_memory' }),
      staleMemory({ id: 'emotion', type: 'emotion_event' }),
    ];

    expect(protectedRows.every(isAutoForgetProtected)).toBe(true);
    expect(selectAutoForgettable(protectedRows, { now: NOW })).toEqual([]);
  });

  it('applies a strict 1% trigger boundary', () => {
    expect(shouldTriggerAutoForget(0, 0.01)).toBe(true);
    expect(shouldTriggerAutoForget(0.009999, 0.01)).toBe(true);
    expect(shouldTriggerAutoForget(0.01, 0.01)).toBe(false);
    expect(shouldTriggerAutoForget(0.9, 0)).toBe(false);
  });
});

describe('Memory M-4 pruning and scheduling', () => {
  let beliefEngine;

  beforeEach(() => {
    beliefEngine = {
      forgetMemoryIds: vi.fn(async () => undefined),
    };
  });

  it('pruneStale forwards the full contract and removes belief evidence first', async () => {
    const targets = [staleMemory({ id: 'm1' })];
    const finder = vi.fn(async (_userId, _companionId, _threshold, opts) => {
      if (opts.purge) await opts.beforeDelete(targets);
      return targets;
    });
    const memory = new Memory({
      userId: 'u1',
      companionId: 'c1',
      beliefEngine,
      forgettableFinder: finder,
    });

    await expect(
      memory.pruneStale({
        threshold: 0.02,
        baseLevelThreshold: -1.5,
        staleDays: 120,
        now: NOW,
      }),
    ).resolves.toEqual({ pruned: 1 });
    expect(finder).toHaveBeenCalledWith(
      'u1',
      'c1',
      0.02,
      expect.objectContaining({
        purge: true,
        now: NOW,
        staleDays: 120,
        baseLevelThreshold: -1.5,
      }),
    );
    expect(beliefEngine.forgetMemoryIds).toHaveBeenCalledWith(['m1']);
  });

  it('keeps dry-run non-destructive and isolates finder failures', async () => {
    const dryFinder = vi.fn(async () => [staleMemory()]);
    const dryMemory = new Memory({
      userId: 'u1',
      forgettableFinder: dryFinder,
    });
    await expect(dryMemory.pruneStale({ dryRun: true, now: NOW })).resolves.toEqual({
      pruned: 1,
    });
    expect(dryFinder.mock.calls[0][3].purge).toBe(false);

    const failingMemory = new Memory({
      userId: 'u1',
      forgettableFinder: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    await expect(failingMemory.pruneStale()).resolves.toEqual({ pruned: 0 });
  });

  it('runs the 1% scheduler at the end of observe without blocking the turn', async () => {
    const finder = vi.fn(async () => []);
    const memory = new Memory({
      userId: 'u1',
      companionId: 'c1',
      autoForgetRandom: () => 0.005,
      forgettableFinder: finder,
    });

    const result = await memory.observe([], {
      now: NOW,
      prospective: false,
      knowledge: false,
      useLLM: false,
    });

    expect(result.autoForgetTriggered).toBe(true);
    expect(finder).toHaveBeenCalledWith(
      'u1',
      'c1',
      0.1,
      expect.objectContaining({
        purge: true,
        now: NOW,
        staleDays: 90,
        strengthThreshold: 0.1,
        baseLevelThreshold: 0.03,
      }),
    );
  });

  it('nightly maintain schedules pruning while ordinary maintenance does not', async () => {
    const pruneStale = vi.fn(async () => ({ pruned: 0 }));
    const fakeOrchestrator = {
      memory: {
        settle: vi.fn(async () => null),
        pruneStale,
      },
      stateLayer: {
        tickActivity: vi.fn(async () => null),
      },
      story: null,
      synthesizeEpisodesNightly: vi.fn(async () => null),
      refreshRelationshipNarrativeNightly: vi.fn(async () => null),
      loadResidentSlots: vi.fn(async () => null),
    };

    await Orchestrator.prototype.maintain.call(fakeOrchestrator, {
      now: NOW,
      nightly: false,
    });
    expect(pruneStale).not.toHaveBeenCalled();

    await Orchestrator.prototype.maintain.call(fakeOrchestrator, {
      now: NOW,
      nightly: true,
    });
    expect(pruneStale).toHaveBeenCalledTimes(1);
  });
});
