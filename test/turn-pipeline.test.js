import { describe, expect, it } from 'vitest';
import {
  TURN_STAGES,
  createTurnContext,
  isWriteStage,
  runTurnStage,
  runTurnPipeline,
  summarizePipeline,
} from '../src/orchestrator/turnPipeline.js';

describe('v4 turn pipeline', () => {
  it('runs all seven stages in order and merges immutable patches', async () => {
    const order = [];
    const handlers = Object.fromEntries(
      TURN_STAGES.map((stage) => [
        stage,
        async (ctx) => {
          order.push(stage);
          expect(ctx.stageResults[stage]).toBeUndefined();
          return { [`_${stage}`]: true };
        },
      ]),
    );
    const result = await runTurnPipeline(
      { userId: 'u1', userMessage: '你好', now: 100, eventId: 'evt-1' },
      handlers,
    );

    expect(order).toEqual(TURN_STAGES);
    expect(result.eventId).toBe('evt-1');
    expect(result._perceive).toBe(true);
    expect(result._commit).toBe(true);
    expect(summarizePipeline(result).stages.every((row) => row.status === 'ok')).toBe(true);
  });

  it('degrades optional stages but stops on compose failure', async () => {
    const seen = [];
    await expect(
      runTurnPipeline(
        { userId: 'u1', userMessage: 'test' },
        {
          perceive: async () => ({ perception: { normalizedMessage: 'test' } }),
          interpret: async () => {
            throw Object.assign(new Error('state unavailable'), { code: 'STATE_DOWN' });
          },
          retrieve: async (ctx) => {
            seen.push(ctx.stageResults.interpret.status);
            return { evidence: {} };
          },
          deliberate: async () => ({ decision: {} }),
          compose: async () => {
            throw new Error('all reply models failed');
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'TurnPipelineError', stage: 'compose' });
    expect(seen).toEqual(['degraded']);
  });

  it('enforces the commit-only write boundary', async () => {
    const permissions = {};
    const context = await runTurnPipeline(
      { userId: 'u1', userMessage: 'test' },
      {
        perceive: async (_ctx, tools) => {
          permissions.perceive = tools.canWrite;
          expect(() => tools.assertCanWrite()).toThrow(/only allowed in commit/);
          return { perception: {} };
        },
        commit: async (_ctx, tools) => {
          permissions.commit = tools.canWrite;
          expect(tools.assertCanWrite()).toBe(true);
          return { commit: { status: 'committed' } };
        },
      },
    );
    expect(permissions).toEqual({ perceive: false, commit: true });
    expect(isWriteStage('commit')).toBe(true);
    expect(context.commit.status).toBe('committed');
  });

  it('creates stable defaults without sharing mutable containers', () => {
    const a = createTurnContext({ userId: 'u', userMessage: 'a', now: 1 });
    const b = createTurnContext({ userId: 'u', userMessage: 'b', now: 1 });
    a.diagnostics.warnings.push({ message: 'x' });
    expect(b.diagnostics.warnings).toEqual([]);
    expect(a.version).toBe(1);
    expect(a.companionId).toBe('default');
  });

  it('supports migrating one production stage at a time', async () => {
    const initial = createTurnContext({
      userId: 'u1',
      eventId: 'evt-1',
      userMessage: 'hello',
    });
    const next = await runTurnStage(initial, 'perceive', async () => ({
      perception: { normalizedMessage: 'hello' },
    }));
    expect(next.perception.normalizedMessage).toBe('hello');
    expect(next.stageResults.perceive.status).toBe('ok');
    expect(next.stageResults.interpret).toBeUndefined();
  });
});
