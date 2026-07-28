import { describe, expect, it, vi } from 'vitest';
import { completedProjectionNames, createTurnProjectionRunner } from '../src/orchestrator/turnProjection.js';

describe('turn projection runner', () => {
  it('skips previously applied projections and checkpoints new work', async () => {
    const checkpoint = vi.fn(async () => ({}));
    const handler = vi.fn();
    const runner = createTurnProjectionRunner({
      eventStore: { checkpoint },
      scope: { userId: 'u1', eventId: 'evt-1', leaseToken: 'lease' },
      priorState: { history: { status: 'applied' } },
    });

    expect(await runner.run('history', handler)).toMatchObject({ skipped: true });
    expect(handler).not.toHaveBeenCalled();
    await runner.run('after_reply', handler, { successStatus: 'dispatched' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith(
      expect.any(Object),
      'after_reply',
      expect.objectContaining({ status: 'dispatched' }),
    );
    expect(completedProjectionNames(runner.snapshot())).toEqual([
      'history',
      'after_reply',
    ]);
  });
});
