import { describe, expect, it } from 'vitest';
import { emptyEvidencePack, retrieveTurn } from '../src/orchestrator/retrieveStage.js';

describe('Retrieve stage', () => {
  it('normalizes memory results into an evidence pack with provenance', async () => {
    const evidence = await retrieveTurn({
      query: '香菜',
      memory: {
        async recall() {
          return {
            block: '对方现在喜欢香菜',
            hits: [
              {
                id: 'm1',
                type: 'preference',
                content: '对方现在喜欢香菜',
                similarity: 0.91,
              },
            ],
          };
        },
      },
    });
    expect(evidence.memoryBlock).toContain('香菜');
    expect(evidence.memoryHits).toHaveLength(1);
    expect(evidence.provenance[0]).toMatchObject({ kind: 'memory', id: 'm1' });
    expect(evidence.budget.hitCount).toBe(1);
    expect(evidence.budget.rawHitCount).toBe(1);
    expect(evidence.budget.decisions[0]).toMatchObject({ id: 'm1' });
  });

  it('rebuilds the prompt from only evidence selected within budget', async () => {
    const evidence = await retrieveTurn({
      query: '饮食',
      evidenceBudget: { maxChars: 60, maxItems: 1 },
      memory: {
        async recall() {
          return {
            block: 'raw block must be replaced',
            hits: [
              { id: 'm1', content: '用户不吃香菜', type: 'preference', similarity: 0.95 },
              { id: 'm2', content: '无关的旧记录'.repeat(20), similarity: 0.01 },
            ],
          };
        },
      },
    });
    expect(evidence.memoryBlock).toContain('不吃香菜');
    expect(evidence.memoryBlock).not.toContain('无关');
    expect(evidence.memoryHits.map((hit) => hit.id)).toEqual(['m1']);
    expect(evidence.budget.droppedCount).toBe(1);
  });

  it('provides an explicit empty evidence pack for degraded retrieval', () => {
    expect(emptyEvidencePack('test')).toEqual({
      query: 'test',
      memoryBlock: '',
      memoryHits: [],
      episodeTexts: [],
      recallExplain: [],
      provenance: [],
      budget: { hitCount: 0, blockChars: 0 },
    });
  });
});
