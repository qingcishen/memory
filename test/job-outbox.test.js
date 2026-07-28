import { describe, expect, it, vi } from 'vitest';
import { enqueueWithClient } from '../src/queue/jobs.js';

function fakeClient({ inserted = null, existing = null } = {}) {
  const maybeSingle = vi.fn(async () => ({ data: inserted, error: null }));
  const single = vi.fn(async () => ({ data: existing, error: null }));
  const selectAfterWrite = vi.fn(() => ({ maybeSingle }));
  const selectForRead = vi.fn(() => ({
    eq: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({ single }),
        }),
      }),
    }),
  }));
  const upsert = vi.fn(() => ({ select: selectAfterWrite }));
  const insert = vi.fn(() => ({ select: selectAfterWrite }));
  const from = vi.fn(() => ({
    upsert,
    insert,
    select: selectForRead,
  }));
  return { client: { from }, spies: { from, upsert, insert, single } };
}

describe('jobs outbox enqueue', () => {
  it('uses the scoped idempotency constraint when event key is present', async () => {
    const existing = { id: 'job-1', status: 'pending' };
    const { client, spies } = fakeClient({ existing });
    const result = await enqueueWithClient(
      client,
      'u1',
      'c1',
      'after-reply',
      { eventId: 'evt-1' },
      { idempotencyKey: 'evt-1:after_reply' },
    );

    expect(spies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: 'evt-1:after_reply' }),
      {
        onConflict: 'user_id,companion_id,kind,idempotency_key',
        ignoreDuplicates: true,
      },
    );
    expect(spies.insert).not.toHaveBeenCalled();
    expect(result).toEqual(existing);
  });

  it('keeps legacy non-idempotent inserts unchanged', async () => {
    const inserted = { id: 'job-2' };
    const { client, spies } = fakeClient({ inserted });
    expect(
      await enqueueWithClient(client, 'u1', 'c1', 'reflect', {}),
    ).toEqual(inserted);
    expect(spies.insert).toHaveBeenCalled();
    expect(spies.upsert).not.toHaveBeenCalled();
  });
});
