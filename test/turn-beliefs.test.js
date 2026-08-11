import { describe, expect, it } from 'vitest';
import {
  CURRENT_ACTIVITY_TTL_MINUTES,
  detectExplicitCurrentActivity,
  extractExplicitTurnBeliefs,
} from '../src/belief/turnBeliefs.js';
import { BeliefEngine } from '../src/belief/index.js';
import { inferTimeGap } from '../src/existence/temporalPerception.js';

const NOW = Date.parse('2026-08-11T12:00:00.000Z');

describe('explicit turn belief projection', () => {
  it.each([
    ['我正在开会，晚点回你', 'working'],
    ['我开车呢，到了说', 'driving'],
    ['我去吃饭了', 'eating'],
    ['我正在健身', 'exercising'],
    ['我去洗澡了', 'showering'],
    ["I'm currently working", 'working'],
  ])('recognizes a narrow current statement: %s', (message, expected) => {
    expect(detectExplicitCurrentActivity(message)).toBe(expected);
  });

  it.each([
    '我明天要开会',
    '我刚开完会',
    '我没在工作',
    '你在开车吗',
    '开会是一种工作',
  ])('rejects plans, past events, negation and non-user claims: %s', (message) => {
    expect(detectExplicitCurrentActivity(message)).toBeNull();
  });

  it('creates a scoped, expiring and replay-stable belief event', () => {
    const [event] = extractExplicitTurnBeliefs(
      [
        { role: 'assistant', content: '我正在吃饭' },
        { role: 'user', content: '我正在开会，结束了找你' },
      ],
      { eventId: 'evt-1', observedAt: NOW, subjectName: '清词' },
    );

    expect(event).toMatchObject({
      id: 'evt-1:belief:current_activity',
      sourceKind: 'user',
      evidenceText: '我正在开会，结束了找你',
      beliefs: [{
        subjectKey: 'user',
        subjectLabel: '清词',
        predicate: 'current_activity',
        objectValue: 'working',
        objectText: '工作',
        beliefKind: 'event',
        epistemicStatus: 'asserted',
        slotKey: 'user:current_activity',
      }],
    });
    expect(event.observedAt).toBe('2026-08-11T12:00:00.000Z');
    expect(event.beliefs[0].validFrom).toBe(event.observedAt);
    expect(Date.parse(event.beliefs[0].validTo) - NOW).toBe(
      CURRENT_ACTIVITY_TTL_MINUTES.working * 60 * 1000,
    );
  });

  it('ignores assistant-only activity statements', () => {
    expect(extractExplicitTurnBeliefs([
      { role: 'assistant', content: '我正在开会' },
    ], { observedAt: NOW })).toEqual([]);
  });

  it('feeds the projected activity into next-turn temporal perception', async () => {
    let projected = null;
    const repository = {
      async project(_userId, _companionId, belief) {
        projected = belief;
        return { belief, created: true };
      },
      async resolve() {
        return {
          status: 'current',
          beliefs: [{ object_value: projected?.objectValue }],
          provenance: [],
        };
      },
    };
    const engine = new BeliefEngine({ userId: 'u1', companionId: 'c1', repository });
    const [event] = extractExplicitTurnBeliefs(
      [{ role: 'user', content: '我正在开会' }],
      { eventId: 'evt-temporal', observedAt: NOW },
    );
    await engine.projectEvent(event);

    const context = await inferTimeGap(
      'u1',
      'c1',
      new Date(NOW + 5 * 60 * 60 * 1000),
      {
        state: { temporal: { last_interaction: new Date(NOW).toISOString() } },
        beliefs: engine,
      },
    );

    expect(context.active_activity).toBe('working');
    expect(context.inferences).toContainEqual(expect.objectContaining({
      type: 'activity_likely_completed',
      activity: 'working',
    }));
  });
});
