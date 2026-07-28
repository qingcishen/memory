import { explainRecallHits } from './explainRecall.js';

/**
 * Retrieve 阶段：调用统一 memory 门面并把返回值规范化成 EvidencePack。
 * 失败由 runTurnStage 按 degradable 语义转为空证据。
 */
export async function retrieveTurn(input = {}) {
  const query = String(input.query ?? input.userMessage ?? '');
  if (!input.memory || typeof input.memory.recall !== 'function') {
    const error = new Error('Retrieve stage requires memory.recall');
    error.code = 'RETRIEVE_MEMORY_UNAVAILABLE';
    throw error;
  }
  const result = await input.memory.recall(query, input.options ?? {});
  const memoryBlock =
    result && typeof result === 'object' && 'block' in result ? result.block : result;
  const memoryHits =
    result && typeof result === 'object' && Array.isArray(result.hits) ? result.hits : [];
  return {
    query,
    memoryBlock: memoryBlock ?? '',
    memoryHits,
    episodeTexts: extractEpisodeEvidence(memoryHits),
    recallExplain: explainRecallHits(memoryHits, query),
    provenance: memoryHits.map((hit) => ({
      kind: 'memory',
      id: hit.id ?? null,
      confidence: hit._confidence ?? hit.confidence ?? null,
      score: hit._activation ?? hit._score ?? hit.similarity ?? null,
    })),
    budget: {
      hitCount: memoryHits.length,
      blockChars: String(memoryBlock ?? '').length,
    },
  };
}

export function emptyEvidencePack(query = '') {
  return {
    query: String(query),
    memoryBlock: '',
    memoryHits: [],
    episodeTexts: [],
    recallExplain: [],
    provenance: [],
    budget: { hitCount: 0, blockChars: 0 },
  };
}

export function extractEpisodeEvidence(hits = []) {
  return (hits ?? [])
    .filter(
      (hit) =>
        hit &&
        (hit.type === 'episode' ||
          /【篇章】|篇章/.test(
            String(hit.fact_core || hit.content || hit.narrative || ''),
          )),
    )
    .map((hit) => hit.narrative || hit.content || hit.fact_core)
    .filter(Boolean)
    .slice(0, 3);
}
