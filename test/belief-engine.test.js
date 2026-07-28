import { describe, expect, it } from 'vitest';
import { BeliefEngine } from '../src/belief/index.js';

function repositorySpy() {
  const calls = [];
  return {
    calls,
    async project(...args) {
      calls.push(['project', ...args]);
      return { belief: args[2], created: true };
    },
    async current(...args) {
      calls.push(['current', ...args]);
      return [{ predicate: 'likes', object_text: '香菜' }];
    },
    async history(...args) {
      calls.push(['history', ...args]);
      return [{ status: 'superseded' }];
    },
    async resolve(...args) {
      calls.push(['resolve', ...args]);
      return { status: 'unknown', beliefs: [], provenance: [] };
    },
    async forgetMemoryIds(...args) {
      calls.push(['forgetMemoryIds', ...args]);
      return { evidenceDeleted: 1, beliefsDeleted: ['b1'] };
    },
  };
}

describe('BeliefEngine API', () => {
  it('projects explicit memory beliefs with memory provenance', async () => {
    const repository = repositorySpy();
    const engine = new BeliefEngine({
      userId: 'u1',
      companionId: 'c1',
      repository,
    });
    await engine.projectMemory({
      id: '11111111-1111-1111-1111-111111111111',
      fact_core: '清词现在喜欢香菜',
      created_at: '2026-07-28T10:00:00.000Z',
      source: {
        speaker: 'user',
        eventId: 'evt-1',
        beliefs: [
          {
            subjectKey: 'user',
            subjectLabel: '清词',
            predicate: 'likes',
            object: '香菜',
            beliefKind: 'preference',
            slotKey: 'user:preference:cilantro',
          },
        ],
      },
    });

    const call = repository.calls[0];
    expect(call[0]).toBe('project');
    expect(call[1]).toBe('u1');
    expect(call[2]).toBe('c1');
    expect(call[4]).toMatchObject({
      sourceKind: 'user',
      sourceId: 'evt-1',
      sourceMemoryId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('does not infer beliefs from unstructured memory text', async () => {
    const repository = repositorySpy();
    const engine = new BeliefEngine({ userId: 'u1', repository });
    expect(await engine.projectMemory({ fact_core: '用户喜欢香菜' })).toEqual([]);
    expect(repository.calls).toEqual([]);
  });

  it('keeps all reads scoped to user and companion', async () => {
    const repository = repositorySpy();
    const engine = new BeliefEngine({
      userId: 'u1',
      companionId: 'c1',
      repository,
    });
    await engine.current({ subjectKey: 'user' });
    await engine.history({ predicate: 'likes' });
    await engine.resolve({ slotKey: 'user:preference:cilantro' });
    await engine.forgetMemoryIds(['11111111-1111-1111-1111-111111111111']);
    expect(repository.calls.map((call) => call.slice(0, 3))).toEqual([
      ['current', 'u1', 'c1'],
      ['history', 'u1', 'c1'],
      ['resolve', 'u1', 'c1'],
      ['forgetMemoryIds', 'u1', 'c1'],
    ]);
  });
});
