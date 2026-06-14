import { supabase, llm, LLM_MODEL, PARAMS } from './config.js';
import { embed } from './embeddings.js';
import { memoryStrength } from './decay.js';

/**
 * 反思: 把最近的零散记忆聚成更高层的总结 (如"诗雅最近压力大, 在备考"),
 * 作为高重要性的 reflection 记忆存回。让伴侣形成"整体印象"而非一堆碎片。
 */
export async function runReflection(userId, opts = {}) {
  const lookback = opts.recent ?? 40;

  const { data: mems, error } = await supabase
    .from('memories')
    .select('id, content, type, importance, emotion, created_at')
    .eq('user_id', userId)
    .is('superseded_by', null)
    .neq('type', 'reflection')
    .order('created_at', { ascending: false })
    .limit(lookback);
  if (error) throw error;
  if (!mems || mems.length < 5) return []; // 太少不值得反思

  const sys = `你在帮一个 AI 伴侣形成对对方的"高层印象"。
阅读下面的零散记忆, 归纳出 1-3 条更概括、更有洞察的总结 (趋势、状态、性格倾向、关系走向)。
不要简单复述, 要提炼。
严格输出 JSON: {"insights":[{"content":"...","importance":1-10,"emotion":0-1}]}。`;

  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: mems.map((m) => `- ${m.content}`).join('\n') },
    ],
  });

  let insights = [];
  try {
    insights = JSON.parse(res.choices[0].message.content).insights || [];
  } catch {
    return [];
  }

  const stored = [];
  for (const ins of insights) {
    const content = String(ins.content || '').trim();
    if (!content) continue;
    const embedding = await embed(content);
    const { data, error: e } = await supabase
      .from('memories')
      .insert({
        user_id: userId,
        type: 'reflection',
        content,
        embedding,
        importance: clampNum(ins.importance, 1, 10, 7),
        emotion: clampNum(ins.emotion, 0, 1, 0.3),
      })
      .select()
      .single();
    if (!e) stored.push(data);
  }
  return stored;
}

/**
 * 找出"几乎被遗忘"的记忆 (强度低于阈值)。默认不删除, 返回供决定。
 * 想自动清理可传 { purge: true }。
 */
export async function findForgettable(userId, threshold = 0.05, opts = {}) {
  const { data: mems, error } = await supabase
    .from('memories')
    .select('*')
    .eq('user_id', userId)
    .is('superseded_by', null);
  if (error) throw error;

  const now = Date.now();
  const weak = (mems || []).filter((m) => memoryStrength(m, now) < threshold);

  if (opts.purge && weak.length > 0) {
    await supabase
      .from('memories')
      .delete()
      .in('id', weak.map((m) => m.id));
  }
  return weak;
}

/**
 * 主动遗忘 (P2 工程债 #9): 纯逻辑。从相似度候选 (如 match_memories 结果) 里
 * 选出"够相关、可以认定为在说这件事"的一批 —— 相似度需达到 threshold。
 * fact_locked (生日/名字/承诺等硬事实) 默认不进遗忘范围, 即使用户随口提到也不误删;
 * 传 { includeLocked: true } 可放开 (用户明确要求时)。
 */
export function selectForgettable(candidates = [], opts = {}) {
  const threshold = opts.threshold ?? PARAMS.forget.similarityThreshold;
  return (candidates ?? []).filter(
    (c) => (c.similarity ?? 0) >= threshold && (opts.includeLocked || !c.fact_locked)
  );
}

/**
 * 主动遗忘 API: "忘记我刚才说的那件事" 这类显式请求。
 * 按 query 向量召回候选, 挑出 selectForgettable 命中的几条直接删除 (不可恢复)。
 * @returns 被删除的记忆列表 (可能为空)
 */
export async function forgetByQuery(userId, query, opts = {}) {
  const queryEmbedding = await embed(query);
  const { data: candidates, error } = await supabase.rpc('match_memories', {
    p_user_id: userId,
    query_embedding: queryEmbedding,
    match_count: opts.pool ?? PARAMS.candidatePool,
  });
  if (error) throw error;

  const targets = selectForgettable(candidates ?? [], opts);
  if (targets.length === 0) return [];

  await supabase
    .from('memories')
    .delete()
    .in('id', targets.map((m) => m.id));
  return targets;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
