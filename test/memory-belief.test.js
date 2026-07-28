import { describe, expect, it } from 'vitest';
import { Memory, projectBeliefInputs } from '../src/memory.js';

describe('Memory belief integration', () => {
  it('keeps old deployments disabled by default', async () => {
    const memory = new Memory({ userId: 'u1' });
    expect(await memory.currentBeliefs()).toEqual([]);
    expect(await memory.resolveBelief()).toMatchObject({ status: 'unknown' });
    await expect(memory.projectBelief({})).rejects.toMatchObject({
      code: 'BELIEF_ENGINE_DISABLED',
    });
  });

  it('projects explicit memories and events while isolating failures', async () => {
    const calls = [];
    const engine = {
      async projectMemory(memory) {
        calls.push(['memory', memory.id]);
        if (memory.id === 'bad') throw new Error('bad evidence');
        return [{ belief: { id: `b-${memory.id}` } }];
      },
      async projectEvent(event) {
        calls.push(['event', event.id]);
        return [{ belief: { id: `b-${event.id}` } }];
      },
    };
    const results = await projectBeliefInputs(engine, {
      memories: [{ id: 'm1' }, { id: 'bad' }],
      events: [{ id: 'e1' }],
    });
    expect(calls).toEqual([
      ['memory', 'm1'],
      ['memory', 'bad'],
      ['event', 'e1'],
    ]);
    expect(results.map((row) => row.belief.id)).toEqual(['b-m1', 'b-e1']);
  });

  it('delegates scoped belief reads to the injected engine', async () => {
    const engine = {
      async current(query) { return [query]; },
      async history(query) { return [query]; },
      async resolve() { return { status: 'current', beliefs: [{ id: 'b1' }] }; },
      async project() { return { created: true }; },
    };
    const memory = new Memory({ userId: 'u1', beliefEngine: engine });
    expect(await memory.currentBeliefs({ predicate: 'likes' })).toEqual([
      { predicate: 'likes' },
    ]);
    expect(await memory.resolveBelief()).toMatchObject({ status: 'current' });
  });
});
