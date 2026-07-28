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
