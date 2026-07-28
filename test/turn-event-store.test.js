import { describe, expect, it } from 'vitest';
import { InMemoryTurnEventStore } from '../src/orchestrator/turnEventStore.js';

describe('turn event store', () => {
  it('claims an event once and exposes its committed outcome', async () => {
    const store = new InMemoryTurnEventStore();
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-1' };

    expect(await store.claim(scope)).toMatchObject({
      acquired: true,
      event: { status: 'processing' },
    });
    await store.complete(scope, { historyAppended: 2 });
    expect(await store.claim(scope)).toMatchObject({
      acquired: false,
      event: {
        status: 'committed',
        result: { historyAppended: 2 },
      },
    });
  });

  it('keeps companion scopes isolated', async () => {
    const store = new InMemoryTurnEventStore();
    expect(
      await store.claim({ userId: 'u1', companionId: 'a', eventId: 'same' }),
    ).toMatchObject({ acquired: true });
    expect(
      await store.claim({ userId: 'u1', companionId: 'b', eventId: 'same' }),
    ).toMatchObject({ acquired: true });
  });

  it('recovers an expired processing lease and fences the stale owner', async () => {
    let now = 1000;
    const store = new InMemoryTurnEventStore({ now: () => now, leaseMs: 100 });
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-stale' };
    const stale = await store.claim(scope);
    expect((await store.claim(scope)).acquired).toBe(false);

    now = 1101;
    const recovered = await store.claim(scope);
    expect(recovered).toMatchObject({
      acquired: true,
      event: { attempts: 2, status: 'processing' },
    });
    await expect(
      store.complete({ ...scope, leaseToken: stale.leaseToken }),
    ).rejects.toMatchObject({ code: 'TURN_EVENT_LEASE_LOST' });
    await expect(
      store.complete({ ...scope, leaseToken: recovered.leaseToken }),
    ).resolves.toMatchObject({ status: 'committed' });
  });

  it('renews an active lease and rejects renewal after expiry', async () => {
    let now = 1000;
    const store = new InMemoryTurnEventStore({ now: () => now, leaseMs: 100 });
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-renew' };
    const claim = await store.claim(scope);

    now = 1050;
    await expect(
      store.renew({ ...scope, leaseToken: claim.leaseToken }),
    ).resolves.toMatchObject({ updated: true, lease_expires_at: 1150 });

    now = 1151;
    await expect(
      store.renew({ ...scope, leaseToken: claim.leaseToken }),
    ).rejects.toMatchObject({ code: 'TURN_EVENT_LEASE_LOST' });
    await expect(
      store.checkpoint(
        { ...scope, leaseToken: claim.leaseToken },
        'history',
        { status: 'applied' },
      ),
    ).rejects.toMatchObject({ code: 'TURN_EVENT_LEASE_LOST' });
  });
});
