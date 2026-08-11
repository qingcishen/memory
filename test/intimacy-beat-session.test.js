import { describe, expect, it, vi } from 'vitest';
import {
  emptySessionThread,
  normalizeSessionThread,
  serializeSessionThread,
  updateSessionThread,
} from '../src/companion/sessionThread.js';
import { commitValidatedReply } from '../src/orchestrator/turnCommit.js';

function fakeOrchestrator(thread = emptySessionThread(1_000)) {
  return {
    userId: 'u1',
    companionId: 'c1',
    _sessionThread: thread,
    history: [],
    persistSessionThread: vi.fn(),
    persistEmotionResidue: vi.fn(),
    recordHistory: vi.fn(),
    afterReply: vi.fn(async () => []),
    maybeDailyLookPhoto: vi.fn(async () => null),
    maybePhoto: vi.fn(async () => null),
  };
}

describe('I-5 intimacy beat session cursor', () => {
  it('survives serialization and a cold-start normalization', () => {
    const thread = {
      ...emptySessionThread(1_000),
      intimacyBeat: { phase: 'foreplay', nextIndex: 3 },
    };

    const restored = normalizeSessionThread(
      JSON.parse(JSON.stringify(serializeSessionThread(thread))),
      2_000,
    );

    expect(restored.intimacyBeat).toEqual({ phase: 'foreplay', nextIndex: 3 });
  });

  it('preserves the cursor unless a successful commit supplies a new one', () => {
    const thread = {
      ...emptySessionThread(1_000),
      intimacyBeat: { phase: 'flirting', nextIndex: 2 },
    };

    const unchanged = updateSessionThread(thread, {
      userMessage: '继续',
      reply: '嗯',
      now: 1_100,
    });
    const advanced = updateSessionThread(unchanged, {
      userMessage: '继续',
      reply: '好',
      intimacyBeat: { phase: 'flirting', nextIndex: 3 },
      now: 1_200,
    });

    expect(unchanged.intimacyBeat).toEqual({ phase: 'flirting', nextIndex: 2 });
    expect(advanced.intimacyBeat).toEqual({ phase: 'flirting', nextIndex: 3 });
  });

  it('advances once at the commit boundary and not on an idempotent replay', async () => {
    const orchestrator = fakeOrchestrator();
    const input = {
      eventId: 'evt-intimacy-beat',
      historyUserMessage: '慢一点',
      reply: '好',
      sceneLocks: [{ id: 'intimate' }],
      intimacyBeat: { phase: 'foreplay', nextIndex: 1 },
      updateSession: updateSessionThread,
    };

    const first = await commitValidatedReply(orchestrator, input);
    const replay = await commitValidatedReply(orchestrator, input);

    expect(first.status).toBe('committed');
    expect(replay.status).toBe('already_committed');
    expect(orchestrator._sessionThread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 1,
    });
    expect(orchestrator._intimacyBeatCursor).toEqual({
      phase: 'foreplay',
      nextIndex: 1,
    });
    expect(orchestrator.persistSessionThread).toHaveBeenCalledTimes(1);
  });

  it('does not advance or persist the cursor when a preceding projection fails', async () => {
    const thread = {
      ...emptySessionThread(1_000),
      intimacyBeat: { phase: 'foreplay', nextIndex: 2 },
    };
    const orchestrator = fakeOrchestrator(thread);
    orchestrator.existence = {
      observeTurn: vi.fn(async () => {
        throw new Error('existence write failed');
      }),
    };

    await expect(
      commitValidatedReply(orchestrator, {
        eventId: 'evt-intimacy-beat-failed-commit',
        historyUserMessage: '继续',
        reply: '好',
        intimacyBeat: { phase: 'foreplay', nextIndex: 3 },
        updateSession: updateSessionThread,
      }),
    ).rejects.toThrow('existence write failed');

    expect(orchestrator._sessionThread.intimacyBeat).toEqual({
      phase: 'foreplay',
      nextIndex: 2,
    });
    expect(orchestrator._intimacyBeatCursor).toBeUndefined();
    expect(orchestrator.persistSessionThread).not.toHaveBeenCalled();
  });
});
