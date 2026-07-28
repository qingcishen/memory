import { describe, expect, it } from 'vitest';
import {
  BeliefQuerySchema,
  beliefKey,
  combineConfidence,
  explicitBeliefsFromMemory,
  normalizeBelief,
  normalizeEvidence,
  sameBelief,
} from '../src/belief/index.js';

describe('temporal belief ontology', () => {
  it('creates a stable key independent of object property order', () => {
    const a = {
      subjectKey: 'user',
      predicate: 'travel_plan',
      object: { city: '泉州', date: '国庆' },
    };
    const b = {
      subject_key: 'user',
      predicate: 'travel_plan',
      object_value: { date: '国庆', city: '泉州' },
    };
    expect(beliefKey(a)).toBe(beliefKey(b));
    expect(sameBelief(a, b)).toBe(true);
  });

  it('downgrades assistant claims about the user to inferred', () => {
    const belief = normalizeBelief(
      {
        subjectKey: 'user',
        subjectLabel: '对方',
        predicate: 'favorite_color',
        object: '蓝色',
        confidence: 0.95,
      },
      { sourceKind: 'assistant' },
    );
    expect(belief.epistemic_status).toBe('inferred');
    expect(belief.confidence).toBeLessThanOrEqual(0.49);
  });

  it('keeps user evidence asserted and temporal fields normalized', () => {
    const belief = normalizeBelief(
      {
        subjectKey: 'user',
        subjectLabel: '清词',
        predicate: 'likes',
        object: '香菜',
        beliefKind: 'preference',
        validFrom: '2026-07-01',
      },
      { sourceKind: 'user' },
    );
    const evidence = normalizeEvidence({
      sourceKind: 'user',
      sourceId: 'event-1',
      evidenceText: '我现在喜欢香菜',
    });
    expect(belief.epistemic_status).toBe('asserted');
    expect(belief.valid_from).toBe('2026-07-01T00:00:00.000Z');
    expect(evidence.evidence_hash).toHaveLength(64);
  });

  it('only projects explicitly structured beliefs from memories', () => {
    expect(explicitBeliefsFromMemory({ fact_core: '用户喜欢香菜' })).toEqual([]);
    expect(
      explicitBeliefsFromMemory({
        fact_core: '用户喜欢香菜',
        source: { beliefs: [{ subjectKey: 'user', predicate: 'likes', object: '香菜' }] },
      }),
    ).toHaveLength(1);
  });

  it('combines independent confidence without exceeding one', () => {
    expect(combineConfidence(0.6, 0.5)).toBeCloseTo(0.8);
    expect(combineConfidence(1, 1)).toBe(0.999);
  });

  it('validates bounded belief queries', () => {
    expect(BeliefQuerySchema.parse({
      subjectKey: 'user',
      at: '2026-07-28T10:00:00.000Z',
      limit: 20,
    })).toEqual({
      subjectKey: 'user',
      at: '2026-07-28T10:00:00.000Z',
      limit: 20,
    });
    expect(() => BeliefQuerySchema.parse({ limit: 1000 })).toThrow();
    expect(() => BeliefQuerySchema.parse({ at: 'tomorrow' })).toThrow();
  });

  it('rejects empty or inverted temporal intervals', () => {
    expect(() =>
      normalizeBelief({
        subjectKey: 'user',
        subjectLabel: '清词',
        predicate: 'works_at',
        object: '新公司',
        validFrom: '2026-08-01T00:00:00.000Z',
        validTo: '2026-07-31T00:00:00.000Z',
      }),
    ).toThrow(/valid_to/);
  });
});
