import { describe, expect, it } from 'vitest';
import {
  buildActionCandidates,
  decideActionUtility,
  scoreActionCandidate,
} from '../src/orchestrator/actionUtility.js';

describe('action utility decision', () => {
  it('uses a hard safety override ahead of ordinary response utility', () => {
    const decision = decideActionUtility({
      userMessage: '停一下',
      goals: [
        { kind: 'safety', priority: 1 },
        { kind: 'intimacy', priority: 0.9, canInitiate: false },
      ],
      sceneLocks: [{ id: 'conflict' }],
    });
    expect(decision.selectedAction).toBe('safety_stop');
    expect(decision.rationaleCodes).toContain('constraint:safety_override');
    expect(
      decision.candidates.find((candidate) => candidate.intent === 'flirt'),
    ).toMatchObject({ feasible: false, utility: null });
  });

  it('penalizes repeated actions without making them infeasible', () => {
    const candidates = buildActionCandidates({
      userMessage: '最近怎么样',
      goals: [{ kind: 'story', priority: 0.8 }],
      recentActionIntents: ['share', 'share'],
    });
    const share = scoreActionCandidate(
      candidates.find((candidate) => candidate.intent === 'share'),
    );
    expect(share.components.repetitionPenalty).toBe(1);
    expect(share.feasible).toBe(true);
  });

  it('is deterministic for the same public inputs', () => {
    const input = {
      userMessage: '明天记得问我',
      goals: [{ kind: 'prospective', priority: 1, sourceId: 'p1' }],
    };
    expect(decideActionUtility(input)).toEqual(decideActionUtility(input));
  });
});
