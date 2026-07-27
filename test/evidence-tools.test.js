import { describe, expect, test } from 'vitest';
import { classificationMetrics } from '../scripts/eval-emotion-labels.js';
import { deriveRecallSamples, fitForgetRate, fitImportanceWeights } from '../scripts/fit-forget-rate.js';
import {
  buildReviewRows,
  finalizeGold,
  redactText,
  reviewAudit,
  traceToCandidates,
} from '../scripts/label-from-traces.js';

describe('evidence tools', () => {
  test('emotion metrics expose accuracy, macro F1 and confusion matrix', () => {
    const result = classificationMetrics([
      { gold: '开心', predicted: '开心' },
      { gold: '失落', predicted: '开心' },
    ]);
    expect(result.accuracy).toBe(0.5);
    expect(result.confusion['失落']['开心']).toBe(1);
  });

  test('forget-rate fit only recommends a well fitted model', () => {
    const result = fitForgetRate([
      { ageDays: 1, recallRate: 1 },
      { ageDays: 2, recallRate: 0.7071 },
      { ageDays: 4, recallRate: 0.5 },
      { ageDays: 8, recallRate: 0.3536 },
    ]);
    expect(result.forgetRate).toBeCloseTo(0.5, 2);
    expect(result.recommend).toBe(true);
  });

  test('access-log cohorts and importance regression enforce data minimums', () => {
    const now = Date.parse('2026-07-27T00:00:00Z');
    const memories = Array.from({ length: 25 }, (_, index) => ({
      created_at: new Date(now - 90 * 86400000).toISOString(),
      access_log: [new Date(now - (89 - index % 5) * 86400000).toISOString()],
    }));
    expect(deriveRecallSamples(memories, { now }).length).toBeGreaterThan(0);
    expect(fitImportanceWeights([{ content: '喜欢咖啡', goldImportance: 5 }]).recommend).toBe(false);
  });

  test('trace labeling is redacted and gold cannot bypass 20% human review', () => {
    expect(redactText('电话 13800138000 邮箱 a@example.com')).not.toContain('13800138000');
    const candidates = traceToCandidates({
      ts: '2026-07-27T00:00:00Z',
      userMessage: '我不喜欢香菜',
      emotionLabel: '平静',
      stateSnapshot: { mood: { valence: 0 }, desires: { attention: 0.2 }, userId: 'secret' },
      lastTurns: [{ role: 'user', content: '我不喜欢香菜' }],
    });
    expect(candidates.some((row) => row.kind === 'emotion')).toBe(true);
    expect(candidates.some((row) => row.kind === 'importance')).toBe(true);
    expect(candidates[0].stateSnapshot.userId).toBeUndefined();

    const initial = Array.from({ length: 300 }, (_, index) => [
      {
        candidateId: `e${index}`, kind: 'emotion', sourceDay: '2026-07-27',
        stateSnapshot: {}, desires: {}, lastTurns: [], initialLabel: '平静', labelModel: 'judge',
      },
      {
        candidateId: `i${index}`, kind: 'importance', sourceDay: '2026-07-27',
        content: `事实${index}`, initialLabel: 5, labelModel: 'judge',
      },
    ]).flat();
    const review = buildReviewRows(initial).map((row) => row.needsReview
      ? {
          ...row,
          reviewStatus: 'reviewed',
          humanLabel: row.initialLabel,
          reviewer: 'human-reviewer',
          reviewedAt: '2026-07-27T00:00:00Z',
        }
      : row);
    expect(reviewAudit(review).pass).toBe(true);
    const gold = finalizeGold(review);
    expect(gold.emotionRows).toHaveLength(300);
    expect(gold.importanceRows).toHaveLength(300);
  });
});
