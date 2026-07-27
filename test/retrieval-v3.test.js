import { describe, expect, test } from 'vitest';
import { reciprocalRankFusion, rerankCandidates } from '../src/retrieve.js';

describe('hybrid retrieval', () => {
  test('RRF combines rankings, deduplicates ids and rewards agreement', () => {
    const rows = reciprocalRankFusion([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }, { id: 'c' }],
    ], 60);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(rows[0]._rrfScore).toBeGreaterThan(rows[1]._rrfScore);
  });

  test('empty keyword results preserve vector order', () => {
    expect(reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }], []], 60).map((row) => row.id))
      .toEqual(['a', 'b']);
  });

  test('LLM reranker is injectable and failure-safe', async () => {
    const items = [
      { id: 'a', similarity: 0.9, importance: 1, last_accessed: new Date().toISOString() },
      { id: 'b', similarity: 0.2, importance: 9, last_accessed: new Date().toISOString() },
    ];
    expect((await rerankCandidates(items, {
      reranker: 'llm',
      llmRerank: async (rows) => [...rows].reverse(),
    }))[0].id).toBe('b');
    expect((await rerankCandidates(items, {
      reranker: 'llm',
      llmRerank: async () => { throw new Error('offline'); },
    })).length).toBe(2);
  });
});
