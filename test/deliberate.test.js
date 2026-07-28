import { describe, expect, it } from 'vitest';
import { deliberateTurn, planRetrievalTurn } from '../src/orchestrator/deliberate.js';

describe('Deliberate stage', () => {
  it('returns an explicit decision and defers prospective writes', async () => {
    const decision = await deliberateTurn({
      userMessage: '明天记得问我面试结果',
      dueItems: [{ id: 'p1', content: '问面试结果' }],
      stateSnapshot: { desires: {}, life: {}, intimacy: {} },
      behavior: {},
      options: {},
    });
    expect(decision.goals.length).toBeGreaterThan(0);
    expect(decision.selectedAction).toBeTruthy();
    expect(decision.prospectiveToDismiss).toEqual(['p1']);
    expect(decision.turnPlan).toBeTruthy();
    expect(decision.structuredPlan).toBeTruthy();
    expect(decision.actionDecision).toMatchObject({ shadow: true });
    expect(decision.candidates.length).toBeGreaterThan(0);
    expect(decision.rationaleCodes.some((code) => code.startsWith('action:'))).toBe(true);
  });

  it('turns an intimacy stop into a top safety constraint', async () => {
    const decision = await deliberateTurn({
      userMessage: '停一下',
      stateSnapshot: { desires: {}, life: {}, intimacy: {} },
      behavior: {},
      options: { stopIntimate: true },
    });
    expect(decision.goals[0].kind).toBe('safety');
    expect(decision.constraints.stopIntimate).toBe(true);
    expect(decision.selectedAction).toBe('safety_stop');
  });

  it('creates a retrieval query without invoking final deliberation', () => {
    const preliminary = planRetrievalTurn({
      userMessage: '上次面试的事情',
      dueItems: [{ id: 'p1', content: '问面试结果' }],
      stateSnapshot: { desires: {}, life: {}, intimacy: {} },
      behavior: {},
      options: {},
    });
    expect(preliminary.turnPlan.recallQuery).toContain('面试');
    expect(preliminary).not.toHaveProperty('structuredPlan');
  });
});
