// K1 · 知识图谱召回: 入口实体向量召回 (RPC) + 进程内有界多跳展开 + 注入格式化。
//
// RPC match_knowledge_entities 只负责"这句话在图里从哪进" (见 sql/knowledge-graph.sql);
// 展开在应用层做: 一次拉该 (user, companion) 的活跃关系边, 进程内 BFS —— 单用户图
// 很小 (几百条边), 一次查询 + 内存展开比多次 SQL 便宜得多 (同 M2 VectorIndex 思路)。
// expandGraph / formatKnowledgeFacts 为纯函数, 可离线单测。

import { supabase, PARAMS } from '../config.js';
import { embed } from '../embeddings.js';

const RELATION_EDGE_LIMIT = 600;

/** 图谱是增强通道，不允许占满主召回预算。 */
export const KNOWLEDGE_RECALL_TIMEOUT_MS = 200;

/**
 * 给图谱增强通道加硬预算。超时和异常均返回 fallback；底层异步任务后续失败也已被
 * catch 吸收，不会产生 unhandled rejection。timer.unref 让超时器不阻止进程退出。
 */
export async function withinKnowledgeRecallBudget(
  task,
  { timeoutMs = KNOWLEDGE_RECALL_TIMEOUT_MS, fallback = null } = {},
) {
  const parsed = Number(timeoutMs);
  const budgetMs = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : KNOWLEDGE_RECALL_TIMEOUT_MS;
  let timer = null;
  const work = Promise.resolve()
    .then(() => (typeof task === 'function' ? task() : task))
    .catch(() => fallback);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 有界多跳展开 (纯函数)。从入口实体出发沿边双向 BFS, 每条边只走一次:
 * @param entryIds 入口实体 id 数组
 * @param edges    [{source_entity_id, target_entity_id, relation, confidence}]
 * @returns 命中的边 (带 hop), 按 (hop 升序, confidence 降序) 排序并截断 maxFacts
 */
export function expandGraph(entryIds = [], edges = [], { maxHops = 2, maxFacts = 8, minConfidence = 0 } = {}) {
  let frontier = new Set(entryIds);
  const visited = new Set(entryIds);
  const usedEdges = new Set();
  const facts = [];
  for (let hop = 1; hop <= maxHops && frontier.size > 0; hop++) {
    const next = new Set();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (usedEdges.has(i)) continue;
      if ((e.confidence ?? 0) < minConfidence) continue;
      const fromSource = frontier.has(e.source_entity_id);
      const fromTarget = frontier.has(e.target_entity_id);
      if (!fromSource && !fromTarget) continue;
      usedEdges.add(i);
      facts.push({ ...e, hop });
      const other = fromSource ? e.target_entity_id : e.source_entity_id;
      if (!visited.has(other)) {
        visited.add(other);
        next.add(other);
      }
    }
    frontier = next;
  }
  facts.sort((a, b) => a.hop - b.hop || (b.confidence ?? 0) - (a.confidence ?? 0));
  return facts.slice(0, maxFacts);
}

/** 命中的边 -> 可注入 prompt 的知识块 (纯函数)。空事实返回空串。 */
export function formatKnowledgeFacts(facts = [], nameById = new Map()) {
  const lines = facts
    .map((f) => {
      const src = nameById.get(f.source_entity_id);
      const tgt = nameById.get(f.target_entity_id);
      if (!src || !tgt) return null;
      return `- ${src} —${f.relation}→ ${tgt}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return '';
  return `你记下的相关人物/事实关系 (客观信息, 自然地用, 别像报菜名):\n${lines.join('\n')}`;
}

/**
 * IO: 当前消息 -> 知识块字符串。整个 embed + DB + 2-hop 路径共用一个 200ms
 * 默认预算；任何一步失败/无命中都返回空串，绝不拖慢或击穿主 recall。
 */
export async function recallKnowledge(userId, companionId, query, opts = {}) {
  const cfg = { ...PARAMS.knowledge, ...opts };
  if (!cfg.enabled || !String(query ?? '').trim()) return '';
  const io = resolveKnowledgeIo(opts.io);
  return withinKnowledgeRecallBudget(
    async () => {
      const queryEmbedding = await io.embed(query);
      const graph = await loadKnowledgeNeighborhood(
        userId,
        companionId,
        query,
        queryEmbedding,
        cfg,
        io,
      );
      if (!graph || graph.facts.length === 0) return '';
      return formatKnowledgeFacts(
        graph.facts,
        new Map(graph.names.map((row) => [row.id, row.canonical_name])),
      );
    },
    { timeoutMs: knowledgeTimeoutMs(cfg), fallback: '' },
  );
}

/**
 * M-2 第三路：实体图谱入口 -> 2-hop 邻域名字 -> 关键词记忆候选。
 *
 * queryEmbedding 复用主召回已生成的向量，不额外调用 embedding。返回值可直接作为
 * RRF 的第三条 lane；该函数自身有独立硬预算和失败降级，因此可安全放进 Promise.all。
 * opts.io 只用于确定性离线验收，生产默认仍走 Supabase。
 */
export async function recallKnowledgeMemoryLane(
  userId,
  companionId,
  query,
  queryEmbedding,
  pool,
  opts = {},
) {
  const cfg = { ...PARAMS.knowledge, ...opts };
  if (!cfg.enabled || !String(query ?? '').trim() || !Array.isArray(queryEmbedding)) return [];
  const io = resolveKnowledgeIo(opts.io);
  return withinKnowledgeRecallBudget(
    async () => {
      const graph = await loadKnowledgeNeighborhood(
        userId,
        companionId,
        query,
        queryEmbedding,
        cfg,
        io,
      );
      if (!graph || graph.names.length === 0) return [];
      const searchText = graph.names
        .map((row) => String(row.canonical_name ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (!searchText) return [];
      const { data, error } = await io.matchMemories({
        userId,
        companionId,
        query,
        queryText: searchText,
        matchCount: pool,
      });
      if (error) return [];
      return data ?? [];
    },
    { timeoutMs: knowledgeTimeoutMs(cfg), fallback: [] },
  );
}

async function loadKnowledgeNeighborhood(
  userId,
  companionId,
  query,
  queryEmbedding,
  cfg,
  io,
) {
  const { data: entries, error: entryError } = await io.matchEntities({
    userId,
    companionId,
    query,
    queryEmbedding,
    matchCount: cfg.entryTopK,
  });
  if (entryError || !entries?.length) return null;

  const entryIds = entries
    .filter((row) => (row.similarity ?? 0) >= cfg.entryMinSimilarity)
    .map((row) => row.id);
  if (entryIds.length === 0) return null;

  const { data: edges, error: edgeError } = await io.loadRelations({
    userId,
    companionId,
    query,
    limit: RELATION_EDGE_LIMIT,
  });
  if (edgeError) return null;

  const facts = expandGraph(entryIds, edges ?? [], cfg);
  const expandedIds = [
    ...new Set([
      ...entryIds,
      ...facts.flatMap((fact) => [fact.source_entity_id, fact.target_entity_id]),
    ]),
  ];
  const { data: names, error: nameError } = await io.loadEntityNames({
    userId,
    companionId,
    query,
    ids: expandedIds,
  });
  if (nameError) return null;
  return { entryIds, facts, names: names ?? [] };
}

function knowledgeTimeoutMs(cfg) {
  return cfg.recallTimeoutMs ?? cfg.timeoutMs ?? KNOWLEDGE_RECALL_TIMEOUT_MS;
}

/**
 * 统一 IO 边界，避免测试伪造 Supabase 的链式 thenable。四个方法仍完整保留 user /
 * companion 作用域；生产调用与旧 SQL 路径一致。
 */
function resolveKnowledgeIo(overrides = {}) {
  return {
    embed: overrides?.embed ?? embed,
    matchEntities: overrides?.matchEntities ?? (({
      userId,
      companionId,
      queryEmbedding,
      matchCount,
    }) => supabase.rpc('match_knowledge_entities', {
      p_user_id: userId,
      query_embedding: queryEmbedding,
      p_companion_id: companionId,
      match_count: matchCount,
    })),
    loadRelations: overrides?.loadRelations ?? (({
      userId,
      companionId,
      limit,
    }) => supabase
      .from('knowledge_relations')
      .select('source_entity_id, target_entity_id, relation, confidence')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('status', 'active')
      .limit(limit)),
    loadEntityNames: overrides?.loadEntityNames ?? (({ ids }) => supabase
      .from('knowledge_entities')
      .select('id, canonical_name')
      .in('id', ids)),
    matchMemories: overrides?.matchMemories ?? (({
      userId,
      companionId,
      queryText,
      matchCount,
    }) => supabase.rpc('match_memories_keyword', {
      p_user_id: userId,
      p_companion_id: companionId,
      query_text: queryText,
      match_count: matchCount,
    })),
  };
}
