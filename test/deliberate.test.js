import { describe, expect, it } from 'vitest';
import { deliberateTurn } from '../src/orchestrator/deliberate.js';

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
  });
});
