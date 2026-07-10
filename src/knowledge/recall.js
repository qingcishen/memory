// K1 · 知识图谱召回: 入口实体向量召回 (RPC) + 进程内有界多跳展开 + 注入格式化。
//
// RPC match_knowledge_entities 只负责"这句话在图里从哪进" (见 sql/knowledge-graph.sql);
// 展开在应用层做: 一次拉该 (user, companion) 的活跃关系边, 进程内 BFS —— 单用户图
// 很小 (几百条边), 一次查询 + 内存展开比多次 SQL 便宜得多 (同 M2 VectorIndex 思路)。
// expandGraph / formatKnowledgeFacts 为纯函数, 可离线单测。

import { supabase, PARAMS } from '../config.js';
import { embed } from '../embeddings.js';

const RELATION_EDGE_LIMIT = 600;

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
 * IO: 当前消息 -> 知识块字符串。任何一步失败/无命中都返回空串, 绝不抛错 ——
 * 图谱是增强, recall 主链路不能被它拖垮 (同 weather/world 的安全降级约定)。
 */
export async function recallKnowledge(userId, companionId, query, opts = {}) {
  const cfg = { ...PARAMS.knowledge, ...opts };
  if (!cfg.enabled || !String(query ?? '').trim()) return '';
  try {
    const queryEmbedding = await embed(query);
    const { data: entries, error } = await supabase.rpc('match_knowledge_entities', {
      p_user_id: userId,
      query_embedding: queryEmbedding,
      p_companion_id: companionId,
      match_count: cfg.entryTopK,
    });
    if (error || !entries?.length) return '';
    const entryIds = entries.filter((e) => (e.similarity ?? 0) >= cfg.entryMinSimilarity).map((e) => e.id);
    if (entryIds.length === 0) return '';

    const { data: edges, error: edgeError } = await supabase
      .from('knowledge_relations')
      .select('source_entity_id, target_entity_id, relation, confidence')
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('status', 'active')
      .limit(RELATION_EDGE_LIMIT);
    if (edgeError || !edges?.length) return '';

    const facts = expandGraph(entryIds, edges, cfg);
    if (facts.length === 0) return '';

    const ids = [...new Set(facts.flatMap((f) => [f.source_entity_id, f.target_entity_id]))];
    const { data: names, error: nameError } = await supabase
      .from('knowledge_entities')
      .select('id, canonical_name')
      .in('id', ids);
    if (nameError) return '';
    return formatKnowledgeFacts(facts, new Map((names ?? []).map((n) => [n.id, n.canonical_name])));
  } catch {
    return '';
  }
}
