// M2 · 引擎门面。把 vector-index + graph(扩散) + activation(含心情门控) 串起来。
//
// 两条用法:
//   rankCandidates(items, state, opts)  —— 纯逻辑: 给候选集打分排序 (扩散+激活), 离线可测
//   engineRecall(userId, query, state)  —— IO: 从 pgvector 拉候选 → embed query → rank → topK → 强化
//
// 与旧 retrieve.js 双轨并存, 验证不退化后再切默认 (见 §3 M2)。

import { supabase, PARAMS } from '../config.js';
import { embed } from '../embeddings.js';
import { scoreActivation } from './activation.js';
import { attachSpread } from './graph.js';
import { VectorIndex } from './vector-index.js';
import { filterBySubject } from '../persona.js';

/**
 * 纯逻辑排序: 候选 → 联想扩散 → 激活打分(含心情门控) → 降序。
 * 不碰 IO; 给定相同输入与状态产出相同顺序。
 * @param items 候选记忆 (含 similarity 与 embedding)
 * @param state M1 关系-情感状态 { mood, relationship }
 * @param opts  { now, params, seedCount, hops, decay, k, threshold }
 */
export function rankCandidates(items, state, opts = {}) {
  if (!items || items.length === 0) return [];
  const withSpread = attachSpread(items, opts);
  return scoreActivation(withSpread, state, opts);
}

/**
 * IO 检索: 心情门控版 recall。
 * @param state 必传 —— 没有状态就退化成 wMood=0 (标准激活)。
 * @param opts  { topK, pool, params }
 */
export async function engineRecall(userId, query, state = null, opts = {}) {
  const topK = opts.topK ?? PARAMS.topK;
  const pool = opts.pool ?? PARAMS.candidatePool;

  const queryEmbedding = await embed(query);
  const { data: candidates, error } = await supabase.rpc('match_memories', {
    p_user_id: userId,
    query_embedding: queryEmbedding,
    match_count: pool,
  });
  if (error) throw error;
  if (!candidates || candidates.length === 0) return [];

  // pgvector 经 supabase-js 回来的 embedding 是字符串 "[...]", 解析成 number[] 供扩散建图。
  let normalized = candidates.map((c) => ({ ...c, embedding: parseVector(c.embedding) }));
  // M4 域隔离: 检索关于"你/我们"的事时默认剔除 self (她的人格设定单独走 personaBlock)。
  normalized = filterBySubject(normalized, opts.subjects ?? ['user', 'dyad']);

  // 没有状态就关掉心情门控 (退化标准激活, 与旧路径可比)
  const params = state ? opts.params : { ...opts.params, wMood: 0 };
  const ranked = rankCandidates(normalized, state ?? {}, { ...opts, params }).slice(0, topK);

  await reinforce(ranked);
  return ranked;
}

/** pgvector → number[]。已是数组则原样返回; 字符串 "[a,b,...]" 解析; 其它给 null。 */
function parseVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 强化: 命中即"又想起一次", 刷新 last_accessed/access_count, 并往 access_log 追加时间戳 (给 base-level)。 */
async function reinforce(mems) {
  const now = new Date().toISOString();
  await Promise.all(
    mems.map((m) => {
      const log = Array.isArray(m.access_log) ? m.access_log : [];
      const nextLog = [...log, now].slice(-50); // 只留最近 50 次, 够 base-level 用
      return supabase
        .from('memories')
        .update({ last_accessed: now, access_count: (m.access_count ?? 0) + 1, access_log: nextLog })
        .eq('id', m.id);
    })
  );
}

export { VectorIndex };
export { scoreActivation } from './activation.js';
export { buildSimGraph, spreadActivation, attachSpread } from './graph.js';
