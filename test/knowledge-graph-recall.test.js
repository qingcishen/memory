import { describe, expect, test } from 'vitest';
import {
  KNOWLEDGE_RECALL_TIMEOUT_MS,
  recallKnowledge,
  recallKnowledgeMemoryLane,
  withinKnowledgeRecallBudget,
} from '../src/knowledge/recall.js';
import { fuseHybridRecallLanes } from '../src/engine/index.js';

describe('M-2 knowledge graph recall acceptance', () => {
  test('uses a 200ms production budget and degrades timeout/rejection to fallback', async () => {
    expect(KNOWLEDGE_RECALL_TIMEOUT_MS).toBe(200);

    const startedAt = performance.now();
    const timedOut = await withinKnowledgeRecallBudget(
      () => new Promise(() => {}),
      { timeoutMs: 20, fallback: [] },
    );
    expect(timedOut).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(150);

    await expect(withinKnowledgeRecallBudget(
      () => Promise.reject(new Error('graph offline')),
      { timeoutMs: 100, fallback: 'safe' },
    )).resolves.toBe('safe');
  });

  test('the prompt graph path shares the same hard budget, including embedding', async () => {
    const startedAt = performance.now();
    const block = await recallKnowledge('u1', 'c1', '小王在哪上班？', {
      enabled: true,
      timeoutMs: 20,
      io: {
        embed: () => new Promise(() => {}),
      },
    });
    expect(block).toBe('');
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  test('expands exactly two hops and converts the neighborhood into a memory lane', async () => {
    const seen = {};
    const names = new Map([
      ['person', '小王'],
      ['company', '腾讯'],
      ['city', '深圳'],
      ['country', '中国'],
    ]);
    const rows = await recallKnowledgeMemoryLane(
      'u1',
      'c1',
      '小王工作的城市',
      [1, 0],
      12,
      {
        timeoutMs: 500,
        entryMinSimilarity: 0.5,
        maxHops: 2,
        maxFacts: 8,
        minConfidence: 0.5,
        io: {
          matchEntities: async () => ({
            data: [{ id: 'person', similarity: 0.99 }],
            error: null,
          }),
          loadRelations: async () => ({
            data: [
              {
                source_entity_id: 'person',
                target_entity_id: 'company',
                relation: 'works_at',
                confidence: 0.95,
              },
              {
                source_entity_id: 'company',
                target_entity_id: 'city',
                relation: 'located_in',
                confidence: 0.9,
              },
              {
                source_entity_id: 'city',
                target_entity_id: 'country',
                relation: 'part_of',
                confidence: 0.9,
              },
            ],
            error: null,
          }),
          loadEntityNames: async ({ ids }) => {
            seen.ids = ids;
            return {
              data: ids.map((id) => ({ id, canonical_name: names.get(id) })),
              error: null,
            };
          },
          matchMemories: async ({ queryText, matchCount }) => {
            seen.queryText = queryText;
            seen.matchCount = matchCount;
            return {
              data: [{ id: 'memory-city', fact_core: '小王在腾讯深圳办公室工作' }],
              error: null,
            };
          },
        },
      },
    );

    expect(rows.map((row) => row.id)).toEqual(['memory-city']);
    expect(seen.ids).toEqual(['person', 'company', 'city']);
    expect(seen.ids).not.toContain('country');
    expect(seen.queryText).toContain('小王');
    expect(seen.queryText).toContain('腾讯');
    expect(seen.queryText).toContain('深圳');
    expect(seen.queryText).not.toContain('中国');
    expect(seen.matchCount).toBe(12);
  });

  test('100 deterministic entity queries achieve at least 70% exact memory hit rate', async () => {
    const indexedEntities = Array.from({ length: 85 }, (_, index) => ({
      id: `person-${index}`,
      embedding: Array.from({ length: 100 }, (_, dimension) => (
        dimension === index ? 1 : 0
      )),
    }));
    const allEdges = indexedEntities.flatMap((entity, index) => [
      {
        source_entity_id: entity.id,
        target_entity_id: `org-${index}`,
        relation: 'works_at',
        confidence: 0.95,
      },
      {
        source_entity_id: `org-${index}`,
        target_entity_id: `city-${index}`,
        relation: 'located_in',
        confidence: 0.9,
      },
    ]);
    const io = {
      matchEntities: async ({ queryEmbedding }) => {
        // 用 100 维 one-hot 向量离线模拟 RPC cosine 排序：库中固定有 85 个实体，
        // 其余 15 个查询没有图谱入口，因此最终精确命中率应稳定为 85%。
        const ranked = indexedEntities
          .map((entity) => ({
            id: entity.id,
            similarity: entity.embedding.reduce(
              (sum, value, index) => sum + value * (queryEmbedding[index] ?? 0),
              0,
            ),
          }))
          .sort((a, b) => b.similarity - a.similarity);
        return { data: ranked.slice(0, 3), error: null };
      },
      loadRelations: async () => ({ data: allEdges, error: null }),
      loadEntityNames: async ({ ids }) => {
        return {
          data: ids.map((id) => {
            const index = Number(id.match(/\d+/)?.[0] ?? -1);
            const prefix = id.startsWith('person-')
              ? '人物'
              : id.startsWith('org-')
                ? '机构'
                : '城市';
            return { id, canonical_name: `${prefix}${index}` };
          }),
          error: null,
        };
      },
      matchMemories: async ({ queryText }) => {
        const index = Number(queryText.match(/城市(\d+)/)?.[1] ?? -1);
        return index >= 0
          ? { data: [{ id: `memory-${index}` }], error: null }
          : { data: [], error: null };
      },
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => recallKnowledgeMemoryLane(
        'u-acceptance',
        'c-acceptance',
        `实体查询 ${index}`,
        Array.from({ length: 100 }, (_, dimension) => (
          dimension === index ? 1 : 0
        )),
        10,
        {
          timeoutMs: 1_000,
          maxHops: 2,
          entryMinSimilarity: 0.5,
          minConfidence: 0.5,
          io,
        },
      )),
    );
    const exactHits = results.filter(
      (rows, index) => rows.some((row) => row.id === `memory-${index}`),
    ).length;
    const hitRate = exactHits / 100;

    expect(exactHits).toBe(85);
    expect(hitRate).toBeGreaterThanOrEqual(0.7);
  });

  test('three-lane RRF rewards agreement and retains unique graph candidates', async () => {
    const rows = await fuseHybridRecallLanes(
      {
        data: [
          { id: 'shared', fact_core: 'vector shared' },
          { id: 'vector-only' },
        ],
      },
      {
        data: [
          { id: 'keyword-only' },
          { id: 'shared', fact_core: 'keyword shared' },
        ],
      },
      Promise.resolve([
        { id: 'shared', fact_core: 'graph shared' },
        { id: 'graph-only' },
      ]),
      { rrfK: 60, knowledgeTimeoutMs: 100 },
    );

    expect(rows[0].id).toBe('shared');
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([
      'shared',
      'vector-only',
      'keyword-only',
      'graph-only',
    ]));
    expect(rows[0]._rrfScore).toBeGreaterThan(rows.find((row) => row.id === 'graph-only')._rrfScore);
  });

  test('stalled or failed graph lane never delays or breaks vector/keyword recall', async () => {
    const vector = { data: [{ id: 'vector-only' }] };
    const keyword = { data: [{ id: 'keyword-only' }] };

    const startedAt = performance.now();
    const stalledRows = await fuseHybridRecallLanes(
      vector,
      keyword,
      () => new Promise(() => {}),
      { knowledgeTimeoutMs: 20 },
    );
    expect(performance.now() - startedAt).toBeLessThan(150);
    expect(stalledRows.map((row) => row.id)).toEqual(['vector-only', 'keyword-only']);

    const failedRows = await fuseHybridRecallLanes(
      vector,
      keyword,
      Promise.reject(new Error('knowledge DB unavailable')),
      { knowledgeTimeoutMs: 100 },
    );
    expect(failedRows.map((row) => row.id)).toEqual(['vector-only', 'keyword-only']);
  });

  test('vector lane remains authoritative while optional lanes degrade', async () => {
    await expect(fuseHybridRecallLanes(
      { data: [], error: new Error('vector RPC failed') },
      Promise.reject(new Error('keyword failed')),
      Promise.reject(new Error('graph failed')),
      { knowledgeTimeoutMs: 100 },
    )).rejects.toThrow('vector RPC failed');
  });
});
