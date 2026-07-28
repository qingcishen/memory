import { describe, expect, it, vi } from 'vitest';
import { dispatchMediaOutbox, isStableMediaReference } from '../src/media/outbox.js';

describe('media delivery outbox', () => {
  it('persists only stable HTTPS references with event-scoped idempotency', async () => {
    const enqueue = vi.fn(async () => ({ id: 'job-1' }));
    const deliverNow = vi.fn();
    const result = await dispatchMediaOutbox({
      asset: {
        url: 'https://media.example/photo.webp',
        kind: 'selfie',
        tags: ['selfie'],
        secretPrompt: 'must not persist',
      },
      route: { chatId: '42' },
      eventId: 'evt-1',
      projection: 'requested_photo',
      enqueue,
      deliverNow,
    });

    expect(result).toMatchObject({ durable: true, mode: 'outbox' });
    expect(enqueue).toHaveBeenCalledWith(
      {
        chatId: '42',
        eventId: 'evt-1',
        asset: {
          url: 'https://media.example/photo.webp',
          kind: 'selfie',
          reason: null,
          tags: ['selfie'],
          cached: false,
        },
      },
      { idempotencyKey: 'evt-1:requested_photo' },
    );
    expect(deliverNow).not.toHaveBeenCalled();
  });

  it('never writes base64 data URLs to the persistent queue', async () => {
    const enqueue = vi.fn();
    const deliverNow = vi.fn(async () => true);
    const asset = { url: 'data:image/png;base64,aGVsbG8=', kind: 'selfie' };
    const result = await dispatchMediaOutbox({
      asset,
      eventId: 'evt-2',
      enqueue,
      deliverNow,
    });

    expect(result).toMatchObject({ durable: false, mode: 'direct' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(deliverNow).toHaveBeenCalledWith(asset);
    expect(isStableMediaReference(asset.url)).toBe(false);
  });
});
