import { explainRecallHits } from './explainRecall.js';
import { PARAMS } from '../params.js';
import { selectEvidenceBudget } from './evidenceBudget.js';

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
  const rawMemoryHits =
    result && typeof result === 'object' && Array.isArray(result.hits) ? result.hits : [];
  const knowledge =
    result && typeof result === 'object' ? String(result.knowledge ?? '') : '';
  const budgetOptions =
    input.evidenceBudget ?? input.options?.evidenceBudget ?? PARAMS.retrieval?.evidenceBudget;
  const knowledgeChars = knowledge.length;
  const configuredMaxChars = Number(budgetOptions?.maxChars) || 2200;
  const includeKnowledge =
    Boolean(knowledge) && knowledgeChars <= Math.floor(configuredMaxChars * 0.35);
  const selection = budgetOptions === false
    ? {
        selected: rawMemoryHits,
        decisions: [],
        dropped: [],
        budget: {
          maxChars: null,
          maxItems: null,
          usedChars: String(memoryBlock ?? '').length,
          selectedCount: rawMemoryHits.length,
          droppedCount: 0,
          estimatedTokens: Math.ceil(String(memoryBlock ?? '').length / 4),
        },
      }
    : selectEvidenceBudget(rawMemoryHits, {
        ...budgetOptions,
        maxChars: Math.max(
          1,
          configuredMaxChars - (includeKnowledge ? knowledgeChars : 0),
        ),
      });
  const memoryHits = selection.selected;
  const selectedMemoryBlock = formatSelectedEvidence(input.memory, memoryHits, {
    knowledge: includeKnowledge ? knowledge : '',
    fallback: memoryBlock,
    unchanged: memoryHits.length === rawMemoryHits.length,
  });
  return {
    query,
    memoryBlock: selectedMemoryBlock,
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
      rawHitCount: rawMemoryHits.length,
      blockChars: selectedMemoryBlock.length,
      maxChars: budgetOptions === false ? null : configuredMaxChars,
      usedChars: selection.budget.usedChars + (includeKnowledge ? knowledgeChars : 0),
      estimatedTokens:
        selection.budget.estimatedTokens + (includeKnowledge ? Math.ceil(knowledgeChars / 4) : 0),
      droppedCount:
        selection.budget.droppedCount + (knowledge && !includeKnowledge ? 1 : 0),
      decisions: selection.decisions,
      dropped: [
        ...selection.dropped,
        ...(knowledge && !includeKnowledge
          ? [{ id: null, source: 'knowledge', reason: 'source_share_budget', charCost: knowledgeChars }]
          : []),
      ],
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

function formatSelectedEvidence(memory, hits, { knowledge, fallback, unchanged }) {
  if (typeof memory?.formatEvidence === 'function') {
    return String(memory.formatEvidence(hits, { knowledge }) ?? '');
  }
  if (unchanged && !knowledge) return String(fallback ?? '');
  const lines = hits
    .map((hit) => hit.narrative ?? hit.fact_core ?? hit.content ?? hit.object_text)
    .filter(Boolean)
    .map((text) => `- ${String(text).trim()}`);
  const memoryText = lines.length ? `相关记忆:\n${lines.join('\n')}` : '';
  return [memoryText, knowledge].filter(Boolean).join('\n\n');
}
