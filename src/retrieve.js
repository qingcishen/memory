import { llm, LLM_MODEL, supabase, PARAMS } from './config.js';
import { embed } from './embeddings.js';
import { rerank } from './decay.js';
import { sanitizeForPrompt } from './promptSafety.js';
import { formatMemoryLine } from './product/preferenceTier.js';
import { scoreActivation } from './engine/activation.js';
import { setMemoryHits } from './trace.js';
import { appendLlmCall } from './trace.js';
import { recordLlmCall } from './metrics.js';

/** Reciprocal Rank Fusion：不要求向量分与关键词分处于同一量纲。 */
export function reciprocalRankFusion(lists, k = 60) {
  const fused = new Map();
  for (const list of lists.filter(Array.isArray)) {
    list.forEach((item, index) => {
      const id = item.id;
      if (!id) return;
      const previous = fused.get(id) ?? { ...item, _rrfScore: 0 };
      fused.set(id, { ...previous, ...item, _rrfScore: previous._rrfScore + 1 / (k + index + 1) });
    });
  }
  return [...fused.values()]
    .map((item) => ({ ...item, similarity: item.similarity ?? item.keyword_similarity ?? item._rrfScore }))
    .sort((a, b) => b._rrfScore - a._rrfScore);
}

/** 统一 reranker 开关；LLM 通道由调用方注入，失败时保持启发式可用。 */
export async function rerankCandidates(candidates, opts = {}) {
  const mode = opts.reranker ?? PARAMS.retrieval?.reranker ?? 'heuristic';
  if (mode === 'activation') return scoreActivation(candidates, opts.state ?? {}, opts.activation);
  if (mode === 'llm') {
    try {
      const reranker = typeof opts.llmRerank === 'function' ? opts.llmRerank : llmRerankCandidates;
      const ranked = await reranker(
        candidates.slice(0, PARAMS.retrieval?.llm?.maxCandidates ?? 20),
        opts.query,
        opts,
      );
      if (Array.isArray(ranked) && ranked.length) return ranked;
    } catch {}
  }
  return rerank(candidates);
}

/** Cheap-model relevance reranker. Scores are blended with the deterministic heuristic. */
export async function llmRerankCandidates(candidates, query, opts = {}) {
  if (!candidates.length) return [];
  const cfg = { heuristicWeight: 0.35, llmWeight: 0.65, maxTokens: 400, ...(PARAMS.retrieval?.llm ?? {}) };
  const model = opts.rerankModel ?? cfg.model ?? LLM_MODEL;
  const client = opts.rerankClient ?? llm;
  const startedAt = Date.now();
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: cfg.maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是记忆检索相关性打分器。只依据记忆是否有助于回答当前问题打 0-10 分。' +
          '不要把情绪强烈误当相关。只输出 JSON: {"scores":[{"id":"...","score":0}]}。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          query: String(query ?? ''),
          memories: candidates.map((item) => ({
            id: item.id,
            text: item.fact_core ?? item.content ?? item.narrative ?? '',
          })),
        }),
      },
    ],
  });
  recordLlmCall('rerank', response.usage);
  appendLlmCall({
    stage: 'rerank',
    model,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
  });
  const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
  const scores = new Map((parsed.scores ?? []).map((row) => [String(row.id), Math.max(0, Math.min(10, Number(row.score) || 0)) / 10]));
  const heuristic = rerank(candidates);
  return heuristic
    .map((item) => ({
      ...item,
      _llmScore: scores.get(String(item.id)) ?? 0,
      _score: cfg.heuristicWeight * (item._score ?? 0) + cfg.llmWeight * (scores.get(String(item.id)) ?? 0),
    }))
    .sort((a, b) => b._score - a._score);
}

/**
 * 按当前 query 检索最相关的记忆。
 * 1) 向量库拉 candidatePool 条 -> 2) similarity+recency+importance 重排
 * -> 3) 取 topK -> 4) 强化命中的记忆 (刷新 last_accessed, access_count+1)
 */
export async function retrieveMemories(userId, companionId = 'default', query, opts = {}) {
  const topK = opts.topK ?? PARAMS.topK;

  const queryEmbedding = await embed(query);
  const pool = opts.pool ?? PARAMS.candidatePool;
  const vectorRequest = supabase.rpc('match_memories', {
    p_user_id: userId,
    p_companion_id: companionId,
    query_embedding: queryEmbedding,
    match_count: pool,
  });
  let candidates;
  if (opts.hybrid ?? PARAMS.retrieval?.hybrid) {
    const [vectorResult, keywordResult] = await Promise.all([
      vectorRequest,
      Promise.resolve(supabase.rpc('match_memories_keyword', {
        p_user_id: userId,
        p_companion_id: companionId,
        query_text: query,
        match_count: pool,
      })).catch(() => ({ data: [] })),
    ]);
    if (vectorResult.error) throw vectorResult.error;
    candidates = reciprocalRankFusion(
      [vectorResult.data ?? [], keywordResult?.error ? [] : keywordResult?.data ?? []],
      PARAMS.retrieval?.rrfK,
    );
  } else {
    const result = await vectorRequest;
    if (result.error) throw result.error;
    candidates = result.data;
  }
  if (!candidates || candidates.length === 0) return [];

  const ranked = (await rerankCandidates(candidates, { ...opts, query })).slice(0, topK);
  setMemoryHits(ranked);
  await reinforce(ranked);
  return ranked;
}

/**
 * 显式"翻旧账"检索: 普通 recall 只看当前有效记忆, 这里先找到与 query 最相关的当前记忆,
 * 再沿 superseded_by 反向捞出被它取代的旧版本。
 *
 * 用途: 回复层想表达"你以前不是..."、"这件事后来变了"时调用。
 * 这样既兑现"旧偏好留痕", 又不让过期事实污染日常回答。
 */
export async function retrieveSupersededTrail(userId, companionId = 'default', query, opts = {}) {
  const queryEmbedding = await embed(query);
  const { data: active, error } = await supabase.rpc('match_memories', {
    p_user_id: userId,
    p_companion_id: companionId,
    query_embedding: queryEmbedding,
    match_count: opts.pool ?? PARAMS.candidatePool,
  });
  if (error) throw error;
  if (!active || active.length === 0) return [];

  const anchors = rerank(active).slice(0, opts.anchorK ?? PARAMS.topK);
  const history = await fetchSupersededBy([...new Set(anchors.map((m) => m.id))], opts.maxDepth ?? 4);
  if (history.length === 0) return [];

  const byId = new Map([...anchors, ...history].map((m) => [m.id, m]));
  const rows = buildSupersededTrail(anchors, history, byId);
  const ranked = rows
    .sort((a, b) => {
      const si = (b.anchor.similarity ?? 0) - (a.anchor.similarity ?? 0);
      if (si !== 0) return si;
      return new Date(b.old.created_at ?? 0).getTime() - new Date(a.old.created_at ?? 0).getTime();
    })
    .slice(0, opts.topK ?? PARAMS.topK);

  await reinforce(ranked.map((r) => r.old));
  return ranked;
}

/** 纯逻辑: 把 active anchors 与历史 rows 组装成 [{ old, replacedBy, anchor }]。 */
export function buildSupersededTrail(anchors, history, byId = null) {
  const map = byId ?? new Map([...(anchors ?? []), ...(history ?? [])].map((m) => [m.id, m]));
  const anchorIds = new Set((anchors ?? []).map((m) => m.id));
  const out = [];

  for (const old of history ?? []) {
    const replacedBy = map.get(old.superseded_by);
    const anchor = findAnchor(old, map, anchorIds);
    if (!replacedBy || !anchor) continue;
    out.push({ old, replacedBy, anchor });
  }
  return out;
}

function findAnchor(mem, map, anchorIds) {
  let cur = mem;
  const seen = new Set();
  while (cur?.superseded_by && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = map.get(cur.superseded_by);
    if (!next) return null;
    if (anchorIds.has(next.id)) return next;
    cur = next;
  }
  return null;
}

// 多角色不变量: 一条记忆的 superseded_by 永远指向【同 (user_id, companion_id)】的记忆
// —— supersede 链只在 storeMemories#supersedeContradictions 里建立, candidates 来自已按
// (user_id, companion_id) 过滤的 match_memories。因此这里沿 superseded_by 反查不带 scope 过滤
// 也不会跨角色泄漏 (seedIds 已是 scope 化的 anchors)。
async function fetchSupersededBy(seedIds, maxDepth) {
  const found = [];
  let frontier = seedIds;
  const seen = new Set(seedIds);

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const { data, error } = await supabase
      .from('memories')
      .select('id, type, content, fact_core, narrative, subject_kind, importance, emotion, created_at, last_accessed, access_count, access_log, superseded_by')
      .in('superseded_by', frontier);
    if (error || !data || data.length === 0) break;

    const fresh = data.filter((m) => !seen.has(m.id));
    for (const m of fresh) seen.add(m.id);
    found.push(...fresh);
    frontier = fresh.map((m) => m.id);
  }
  return found;
}

/** 强化: 被检索命中等于"又想起一次", 刷新时间并累加访问次数 */
async function reinforce(mems) {
  const now = new Date().toISOString();
  await Promise.all(
    mems.map((m) => {
      const log = Array.isArray(m.access_log) ? m.access_log : [];
      return supabase
        .from('memories')
        .update({ last_accessed: now, access_count: (m.access_count ?? 0) + 1, access_log: [...log, now].slice(-50) })
        .eq('id', m.id);
    })
  );
}

/** 把记忆列表拼成可直接注入 system prompt 的自然语言 */
export function formatForPrompt(mems, subjectName = '对方') {
  if (!mems || mems.length === 0) return '';
  // 注入时优先用 narrative(她当下的解读), 没有才退回 fact_core/content
  // sanitizeForPrompt: 记忆文本来自用户输入/LLM 提取, 不可信, 过滤可疑的 prompt 注入话术
  // _lowConfidence (#4 不确定性表达): 相关度低/很久没强化/同话题情绪冲突 → "我记得好像..."
  // 偏好分层：硬边界 / 稳定偏好 / 一时兴起 在行首标注，避免把 whim 当铁律
  const lines = mems
    .map((m) => {
      const text = sanitizeForPrompt(m.narrative || m.fact_core || m.content);
      if (!text) return '';
      const tiered = formatMemoryLine(
        { ...m, narrative: text, fact_core: text },
        { lowConfidence: Boolean(m._lowConfidence) },
      );
      const line = tiered || (m._lowConfidence ? `- 我记得好像${text}` : `- ${text}`);
      if (!line) return '';
      // 把记录日期注入「- 」后，帮助模型回答"什么时候"类时序问题
      const dateTag = m.created_at ? `[${String(m.created_at).slice(0, 10)}] ` : '';
      return dateTag ? line.replace(/^- /, `- ${dateTag}`) : line;
    })
    .filter(Boolean)
    .join('\n');
  return `你记得关于${subjectName}的事:\n${lines}\n（标「硬边界」的绝不当玩笑改写；「一时兴起」别当成永久设定。）`;
}

/** 把"旧版本 → 当前版本"拼成可注入的历史偏好块。 */
export function formatSupersededTrailForPrompt(rows, subjectName = '对方') {
  if (!rows || rows.length === 0) return '';
  const lines = rows.map(({ old, replacedBy }) => {
    const before = sanitizeForPrompt(old.narrative || old.fact_core || old.content);
    const after = sanitizeForPrompt(replacedBy.narrative || replacedBy.fact_core || replacedBy.content);
    return `- 以前: ${before}; 后来更新为: ${after}`;
  });
  return `你记得${subjectName}以前说法/偏好的变化:\n${lines.join('\n')}`;
}
