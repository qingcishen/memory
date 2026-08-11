import { describe, expect, it, vi } from 'vitest';
import {
  ResilientBeliefEngine,
  ResilientTurnEventStore,
  isMissingCognitiveSchemaError,
} from '../src/orchestrator/cognitiveCore.js';
import { InMemoryTurnEventStore } from '../src/orchestrator/turnEventStore.js';
import { MemoryAdapter } from '../src/orchestrator/adapters.js';

function missingSchemaError(code = '42P01') {
  return Object.assign(new Error('relation "beliefs" does not exist'), { code });
}

describe('production cognitive core fallbacks', () => {
  it('recognizes Postgres and PostgREST migration errors only', () => {
    expect(isMissingCognitiveSchemaError(missingSchemaError())).toBe(true);
    expect(isMissingCognitiveSchemaError({ code: 'PGRST202', message: 'missing RPC' })).toBe(true);
    expect(isMissingCognitiveSchemaError(new Error('network timeout'))).toBe(false);
  });

  it('disables the belief projection after a missing-schema response', async () => {
    const primary = {
      userId: 'u1',
      companionId: 'c1',
      current: vi.fn().mockRejectedValue(missingSchemaError()),
    };
    const onFallback = vi.fn();
    const engine = new ResilientBeliefEngine({ primary, onFallback });

    await expect(engine.current({ predicate: 'current_activity' })).resolves.toEqual([]);
    await expect(engine.current({ predicate: 'current_activity' })).resolves.toEqual([]);

    expect(primary.current).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'belief_engine',
    }));
    expect(engine.schemaAvailable).toBe(false);
    await expect(engine.resolve()).resolves.toMatchObject({ status: 'unknown' });
  });

  it('does not hide transient belief failures', async () => {
    const engine = new ResilientBeliefEngine({
      primary: {
        userId: 'u1',
        companionId: 'c1',
        resolve: vi.fn().mockRejectedValue(new Error('network timeout')),
      },
    });
    await expect(engine.resolve()).rejects.toThrow('network timeout');
    expect(engine.schemaAvailable).toBe(true);
  });

  it('switches the turn ledger to one in-memory backend before a lease exists', async () => {
    const primary = { claim: vi.fn().mockRejectedValue(missingSchemaError('PGRST202')) };
    const fallback = new InMemoryTurnEventStore();
    const store = new ResilientTurnEventStore({ primary, fallback, onFallback: vi.fn() });
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-1' };

    const claim = await store.claim(scope);
    await store.checkpoint(
      { ...scope, leaseToken: claim.leaseToken },
      'history',
      { status: 'applied' },
    );
    await store.complete({ ...scope, leaseToken: claim.leaseToken }, { ok: true });

    expect(store.backend).toBe('fallback');
    await expect(store.claim(scope)).resolves.toMatchObject({
      acquired: false,
      event: { status: 'committed' },
    });
    expect(primary.claim).toHaveBeenCalledTimes(1);
  });

  it('never changes ledger backend after a primary lease was acquired', async () => {
    const primary = {
      claim: vi.fn().mockResolvedValue({ acquired: true, leaseToken: 'db-lease' }),
      checkpoint: vi.fn().mockRejectedValue(missingSchemaError()),
    };
    const store = new ResilientTurnEventStore({ primary });
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-2' };
    await store.claim(scope);

    await expect(
      store.checkpoint({ ...scope, leaseToken: 'db-lease' }, 'history', {}),
    ).rejects.toThrow('does not exist');
    expect(store.backend).toBe('primary');
  });

  it('freezes the primary backend after observing an existing database event', async () => {
    const primary = {
      claim: vi.fn()
        .mockResolvedValueOnce({ acquired: false, event: { status: 'committed' } })
        .mockRejectedValueOnce(missingSchemaError()),
    };
    const store = new ResilientTurnEventStore({ primary });
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-existing' };

    await expect(store.claim(scope)).resolves.toMatchObject({ acquired: false });
    await expect(store.claim(scope)).rejects.toThrow('does not exist');
    expect(store.backend).toBe('primary');
  });

  it('passes the belief engine through the production memory adapter', () => {
    const beliefEngine = { current: vi.fn() };
    const adapter = new MemoryAdapter({ userId: 'u1', beliefEngine });
    expect(adapter._mem.beliefEngine).toBe(beliefEngine);
  });
});
