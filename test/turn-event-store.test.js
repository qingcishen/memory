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
});
