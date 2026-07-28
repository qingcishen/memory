import { describe, expect, it, vi } from 'vitest';
import { commitValidatedReply, createTurnEventId } from '../src/orchestrator/turnCommit.js';

function fakeOrchestrator() {
  return {
    _sessionThread: { id: 's1' },
    history: [],
    persistSessionThread: vi.fn(),
    persistEmotionResidue: vi.fn(),
    recordHistory: vi.fn(function record(turns) {
      this.history.push(...turns);
    }),
    afterReply: vi.fn(async () => []),
    maybeDailyLookPhoto: vi.fn(async () => null),
    maybePhoto: vi.fn(async () => null),
  };
}

describe('turn commit boundary', () => {
  it('requires an event id before long-term writes', () => {
    expect(() =>
      commitValidatedReply(fakeOrchestrator(), {
        historyUserMessage: 'hi',
        reply: 'hello',
        updateSession: (value) => value,
      }),
    ).toThrow(/stable eventId/);
  });

  it('commits history and background work through one boundary', () => {
    const orchestrator = fakeOrchestrator();
    const result = commitValidatedReply(orchestrator, {
      eventId: 'evt-1',
      historyUserMessage: 'hi',
      reply: 'hello',
      sceneLocks: [],
      relationshipStage: { id: 'close' },
      stateSnapshot: {},
      photoRequested: true,
      updateSession: (thread, turn) => ({ ...thread, lastReply: turn.reply }),
    });

    expect(result.status).toBe('committed');
    expect(orchestrator.recordHistory).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      { eventId: 'evt-1' },
    );
    expect(orchestrator.afterReply).toHaveBeenCalledWith(
      'hi',
      'hello',
      expect.objectContaining({ eventId: 'evt-1' }),
    );
    expect(orchestrator.maybePhoto).toHaveBeenCalled();
  });

  it('preserves caller event ids and creates scoped ids otherwise', () => {
    expect(createTurnEventId({ eventId: 'channel-1' })).toBe('channel-1');
    expect(
      createTurnEventId({ userId: 'u1', companionId: 'c1', now: 123 }),
    ).toMatch(/^turn:u1:c1:123:/);
  });
});
