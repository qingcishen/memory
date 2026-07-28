import { describe, expect, it, vi } from 'vitest';
import { commitValidatedReply, createTurnEventId } from '../src/orchestrator/turnCommit.js';
import { InMemoryTurnEventStore } from '../src/orchestrator/turnEventStore.js';

function fakeOrchestrator() {
  return {
    userId: 'u1',
    companionId: 'c1',
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
  it('requires an event id before long-term writes', async () => {
    await expect(
      commitValidatedReply(fakeOrchestrator(), {
        historyUserMessage: 'hi',
        reply: 'hello',
        updateSession: (value) => value,
      }),
    ).rejects.toThrow(/stable eventId/);
  });

  it('commits history and background work through one boundary', async () => {
    const orchestrator = fakeOrchestrator();
    const result = await commitValidatedReply(orchestrator, {
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

  it('does not duplicate writes when the same event is committed twice', async () => {
    const orchestrator = fakeOrchestrator();
    const input = {
      eventId: 'evt-repeat',
      historyUserMessage: 'hi',
      reply: 'hello',
      updateSession: (value) => value,
    };
    const first = await commitValidatedReply(orchestrator, input);
    const second = await commitValidatedReply(orchestrator, input);
    expect(first.idempotentReplay).toBe(false);
    expect(second).toMatchObject({
      status: 'already_committed',
      idempotentReplay: true,
    });
    expect(orchestrator.recordHistory).toHaveBeenCalledTimes(1);
    expect(orchestrator.afterReply).toHaveBeenCalledTimes(1);
  });

  it('suppresses duplicate commits across orchestrator instances through a shared ledger', async () => {
    const turnEventStore = new InMemoryTurnEventStore();
    const firstOrchestrator = { ...fakeOrchestrator(), turnEventStore };
    const secondOrchestrator = { ...fakeOrchestrator(), turnEventStore };
    const input = {
      eventId: 'evt-cross-process',
      historyUserMessage: 'hi',
      reply: 'hello',
      updateSession: (value) => value,
    };

    const first = await commitValidatedReply(firstOrchestrator, input);
    const second = await commitValidatedReply(secondOrchestrator, input);

    expect(first.status).toBe('committed');
    expect(second).toMatchObject({
      status: 'already_committed',
      idempotentReplay: true,
    });
    expect(firstOrchestrator.recordHistory).toHaveBeenCalledTimes(1);
    expect(secondOrchestrator.recordHistory).not.toHaveBeenCalled();
  });

  it('resumes an expired commit from the first unfinished projection', async () => {
    let now = 1000;
    const turnEventStore = new InMemoryTurnEventStore({ now: () => now, leaseMs: 100 });
    const scope = { userId: 'u1', companionId: 'c1', eventId: 'evt-resume' };
    const stale = await turnEventStore.claim(scope);
    await turnEventStore.checkpoint(
      { ...scope, leaseToken: stale.leaseToken },
      'history',
      { status: 'applied' },
    );
    now = 1101;

    const orchestrator = { ...fakeOrchestrator(), turnEventStore };
    const result = await commitValidatedReply(orchestrator, {
      eventId: scope.eventId,
      historyUserMessage: 'hi',
      reply: 'hello',
      updateSession: (value) => value,
    });

    expect(result.status).toBe('committed');
    expect(result.history.appended).toBe(0);
    expect(orchestrator.recordHistory).not.toHaveBeenCalled();
    expect(orchestrator.afterReply).toHaveBeenCalledTimes(1);
    expect(result.projections.completed).toContain('history');
    expect(result.projections.completed).toContain('after_reply');
  });

  it('checkpoints durable after-reply enqueue as enqueued', async () => {
    const orchestrator = {
      ...fakeOrchestrator(),
      afterReplyEnqueue: vi.fn(),
      turnEventStore: new InMemoryTurnEventStore(),
    };
    const result = await commitValidatedReply(orchestrator, {
      eventId: 'evt-outbox',
      historyUserMessage: 'hi',
      reply: 'hello',
      updateSession: (value) => value,
    });

    expect(result.projections.state.after_reply.status).toBe('enqueued');
  });

  it('renews the ledger lease before every unfinished projection', async () => {
    const turnEventStore = new InMemoryTurnEventStore();
    const renew = vi.spyOn(turnEventStore, 'renew');
    const orchestrator = { ...fakeOrchestrator(), turnEventStore };

    const result = await commitValidatedReply(orchestrator, {
      eventId: 'evt-heartbeat',
      historyUserMessage: 'hi',
      reply: 'hello',
      photoRequested: false,
      updateSession: (value) => value,
    });

    expect(result.status).toBe('committed');
    expect(renew).toHaveBeenCalledTimes(7);
    expect(renew.mock.calls.every(([scope]) => scope.leaseToken)).toBe(true);
  });
});
