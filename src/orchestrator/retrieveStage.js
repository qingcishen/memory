import { explainRecallHits } from './explainRecall.js';
import { PARAMS } from '../params.js';
import { selectEvidenceBudget } from './evidenceBudget.js';
import { sanitizeForPrompt } from '../promptSafety.js';

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
  const beliefOptions =
    input.beliefs ?? input.options?.beliefs ?? PARAMS.retrieval?.beliefs;
  const [result, currentBeliefs] = await Promise.all([
    input.memory.recall(query, input.options ?? {}),
    beliefOptions === false || typeof input.memory.currentBeliefs !== 'function'
      ? Promise.resolve([])
      : input.memory.currentBeliefs({
          at: normalizeAt(input.options?.now),
          limit: positiveLimit(beliefOptions?.candidateLimit, 40),
        }).catch(() => []),
  ]);
  const memoryBlock =
    result && typeof result === 'object' && 'block' in result ? result.block : result;
  const rawMemoryHits =
    result && typeof result === 'object' && Array.isArray(result.hits) ? result.hits : [];
  const rawBeliefs = (Array.isArray(currentBeliefs) ? currentBeliefs : [])
    .map((belief) => beliefToEvidence(belief, query))
    .filter(Boolean);
  const rawEvidence = [...rawMemoryHits, ...rawBeliefs];
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
        selected: rawEvidence,
        decisions: [],
        dropped: [],
        budget: {
          maxChars: null,
          maxItems: null,
          usedChars: String(memoryBlock ?? '').length,
          selectedCount: rawEvidence.length,
          droppedCount: 0,
          estimatedTokens: Math.ceil(String(memoryBlock ?? '').length / 4),
        },
      }
    : selectEvidenceBudget(rawEvidence, {
        ...budgetOptions,
        maxChars: Math.max(
          1,
          configuredMaxChars - (includeKnowledge ? knowledgeChars : 0),
        ),
      });
  const memoryHits = selection.selected.filter((item) => item.source_kind !== 'belief');
  const beliefs = selection.selected.filter((item) => item.source_kind === 'belief');
  const selectedMemoryBlock = formatSelectedEvidence(input.memory, memoryHits, {
    knowledge: includeKnowledge ? knowledge : '',
    fallback: memoryBlock,
    unchanged: memoryHits.length === rawMemoryHits.length,
  });
  const beliefBlock = formatBeliefEvidence(beliefs);
  const evidenceBlock = [beliefBlock, selectedMemoryBlock].filter(Boolean).join('\n\n');
  return {
    query,
    memoryBlock: evidenceBlock,
    memoryHits,
    beliefs,
    episodeTexts: extractEpisodeEvidence(memoryHits),
    recallExplain: explainRecallHits(memoryHits, query),
    provenance: [
      ...beliefs.map((belief) => ({
        kind: 'belief',
        id: belief.id ?? null,
        confidence: belief.confidence ?? null,
        score: belief.relevance ?? belief._score ?? null,
        predicate: belief.predicate ?? null,
        sourceMemoryId: belief.source_memory_id ?? null,
      })),
      ...memoryHits.map((hit) => ({
        kind: 'memory',
        id: hit.id ?? null,
        confidence: hit._confidence ?? hit.confidence ?? null,
        score: hit._activation ?? hit._score ?? hit.similarity ?? null,
      })),
    ],
    budget: {
      hitCount: memoryHits.length,
      rawHitCount: rawMemoryHits.length,
      beliefCount: beliefs.length,
      rawBeliefCount: rawBeliefs.length,
      blockChars: evidenceBlock.length,
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
    beliefs: [],
    episodeTexts: [],
    recallExplain: [],
    provenance: [],
    budget: { hitCount: 0, blockChars: 0 },
  };
}

const PREDICATE_LABELS = Object.freeze({
  likes: '喜欢',
  dislikes: '不喜欢',
  avoids: '会避开',
  prefers: '更偏好',
  has_boundary: '明确边界是',
  name: '名字是',
  birth_date: '生日是',
  lives_in: '住在',
  works_at: '工作于',
  studies_at: '就读于',
  occupation: '职业是',
  allergic_to: '对其过敏',
  current_activity: '当前正在',
});

/** 把当前 belief 变成统一预算候选；不会接收 history/superseded 行。 */
export function beliefToEvidence(belief = {}, query = '') {
  if (!belief?.id || belief.status !== 'active' || !belief.object_text) return null;
  const objectText = sanitizeForPrompt(belief.object_text);
  if (!objectText) return null;
  const predicateLabel = PREDICATE_LABELS[belief.predicate] ?? belief.predicate;
  const subject = belief.subject_key === 'user'
    ? '用户'
    : sanitizeForPrompt(belief.subject_label ?? belief.subject_key);
  const content = `${subject}${predicateLabel}${objectText}`;
  const relevance = beliefRelevance(query, {
    ...belief,
    content,
    object_text: objectText,
  });
  // 完全不相关的低置信 belief 不占候选预算；高置信身份/偏好保留低基线供直接问答。
  if (relevance < 0.08 && Number(belief.confidence) < 0.8) return null;
  return {
    ...belief,
    source_kind: 'belief',
    content,
    narrative: content,
    relevance,
    _score: relevance,
    created_at: belief.last_confirmed_at ?? belief.updated_at ?? belief.created_at,
  };
}

export function beliefRelevance(query, belief = {}) {
  const q = normalizeSearchText(query);
  if (!q) return 0.2;
  const object = normalizeSearchText(belief.object_text);
  const predicate = normalizeSearchText(
    `${belief.predicate ?? ''}${PREDICATE_LABELS[belief.predicate] ?? ''}`,
  );
  const content = normalizeSearchText(belief.content);
  if (object && (q.includes(object) || object.includes(q))) return 1;
  const qChars = new Set([...q].filter(isUsefulChar));
  const contentChars = new Set([...content].filter(isUsefulChar));
  const overlap = [...qChars].filter((char) => contentChars.has(char)).length;
  const lexical = qChars.size ? overlap / qChars.size : 0;
  const asksIdentity = /(我是谁|名字|生日|住哪|哪里人|工作|职业|学校|过敏)/.test(q);
  const asksPreference = /(喜欢|不喜欢|讨厌|偏好|爱吃|不吃|边界)/.test(q);
  const asksActivity = /(在干嘛|做什么|忙什么|现在|正在|结束了吗)/.test(q);
  const intentBoost =
    (asksIdentity && belief.belief_kind === 'identity') ||
    (asksPreference && belief.belief_kind === 'preference') ||
    (asksActivity && belief.predicate === 'current_activity')
      ? 0.38
      : 0;
  const predicateBoost = predicate && q.includes(predicate) ? 0.28 : 0;
  return Math.min(1, Math.max(0.05, lexical * 0.75 + intentBoost + predicateBoost));
}

export function formatBeliefEvidence(beliefs = []) {
  const lines = beliefs
    .map((belief) => sanitizeForPrompt(belief.content))
    .filter(Boolean)
    .map((text) => `- ${text}`);
  return lines.length
    ? `【当前有效的结构化事实】\n${lines.join('\n')}\n这些事实带有效期与来源；只按字面使用，不延伸猜测。`
    : '';
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

function normalizeAt(value) {
  const date = new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function positiveLimit(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(200, number) : fallback;
}

function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '').replace(/[，。！？、,.!?：:；;（）()]/g, '');
}

function isUsefulChar(char) {
  return /[\p{L}\p{N}]/u.test(char);
}
