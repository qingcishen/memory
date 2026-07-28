import { describe, expect, it } from 'vitest';
import { scoreEvidence, selectEvidenceBudget } from '../src/orchestrator/evidenceBudget.js';

describe('evidence budget selector', () => {
  it('prefers high-utility evidence under a bounded character budget', () => {
    const result = selectEvidenceBudget(
      [
        { id: 'weak', content: '很长但不相关的普通记录'.repeat(8), similarity: 0.05 },
        { id: 'useful', content: '用户不吃香菜', type: 'preference', similarity: 0.95 },
        { id: 'duplicate', content: '用户不吃香菜', similarity: 0.9 },
      ],
      { maxChars: 80, maxItems: 2, now: Date.parse('2026-07-28') },
    );

    expect(result.selected.map((item) => item.id)).toEqual(['useful']);
    expect(result.budget).toMatchObject({
      maxChars: 80,
      selectedCount: 1,
      droppedCount: 1,
    });
    expect(result.decisions[0]).toMatchObject({
      id: 'useful',
      reason: 'selected',
    });
  });

  it('keeps one locked fact even when it exceeds a tiny budget', () => {
    const result = selectEvidenceBudget(
      [{ id: 'locked', fact_core: '不可改写的生日事实', fact_locked: true }],
      { maxChars: 1, maxItems: 1 },
    );
    expect(result.selected[0].id).toBe('locked');
    expect(result.decisions[0].reason).toBe('mandatory');
  });

  it('penalizes superseded evidence', () => {
    const current = scoreEvidence({ content: '现在喜欢茶', similarity: 0.8 });
    const old = scoreEvidence({
      content: '以前喜欢咖啡',
      similarity: 0.8,
      status: 'superseded',
    });
    expect(current.utility).toBeGreaterThan(old.utility);
  });
});
