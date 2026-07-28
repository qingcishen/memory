import { describe, expect, it, vi } from 'vitest';
import { BeliefRepository } from '../src/belief/index.js';

function queryClient(rows = []) {
  const calls = [];
  const request = {
    select() { return this; },
    eq(...args) { calls.push(['eq', ...args]); return this; },
    or(value) { calls.push(['or', value]); return this; },
    order() { return this; },
    limit() { return this; },
    then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
  };
  return {
    calls,
    client: {
      from(table) {
        calls.push(['from', table]);
        return request;
      },
    },
  };
}

describe('belief repository temporal queries', () => {
  it('bounds current beliefs to the requested valid-time instant', async () => {
    const { client, calls } = queryClient([{ id: 'belief-1' }]);
    const repository = new BeliefRepository({ client });
    const at = '2026-07-28T10:00:00.000Z';

    await expect(
      repository.current('u1', 'c1', { subjectKey: 'user', at }),
    ).resolves.toEqual([{ id: 'belief-1' }]);

    expect(calls).toContainEqual(['or', `valid_from.is.null,valid_from.lte.${at}`]);
    expect(calls).toContainEqual(['or', `valid_to.is.null,valid_to.gt.${at}`]);
  });

  it('uses current wall time when no as-of instant is supplied', async () => {
    const { client, calls } = queryClient();
    const repository = new BeliefRepository({ client });
    const before = Date.now();

    await repository.current('u1', 'c1');

    const temporalFilters = calls
      .filter(([method]) => method === 'or')
      .map(([, value]) => value);
    const validFrom = temporalFilters.find((value) => value.startsWith('valid_from'));
    const queriedAt = Date.parse(validFrom.slice(validFrom.indexOf('.lte.') + 5));
    expect(queriedAt).toBeGreaterThanOrEqual(before);
    expect(queriedAt).toBeLessThanOrEqual(Date.now());
  });

  it('forgets memory-backed evidence through the scoped atomic RPC', async () => {
    const rpc = vi.fn(async () => ({
      data: { evidence_deleted: 2, beliefs_deleted: ['b1'] },
      error: null,
    }));
    const repository = new BeliefRepository({ client: { rpc } });
    const memoryId = '11111111-1111-1111-1111-111111111111';

    await expect(
      repository.forgetMemoryIds('u1', 'c1', [memoryId, memoryId, '']),
    ).resolves.toEqual({
      evidenceDeleted: 2,
      beliefsDeleted: ['b1'],
    });
    expect(rpc).toHaveBeenCalledWith('forget_memory_beliefs', {
      p_user_id: 'u1',
      p_companion_id: 'c1',
      p_memory_ids: [memoryId],
    });
  });
});
