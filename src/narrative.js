// M4 · 共同记忆与关系叙事 (招牌②的另一半)。
//
// dyad 记忆 = 双方共有、带情感产权的共同记忆 ("我们一起淋的那场雨")。
// 两个用途:
//   1) 关系底色: recall 时无条件带 1~2 条最重要的 dyad 记忆, 让她始终"记得我们"
//   2) 关系叙事: 定期把 dyad 记忆 + 当前关系状态合成一段"我们的故事"(narrative identity),
//      作为最高层 reflection 存回 —— 她对这段关系的连贯自我叙述。
//
// 纯逻辑 (挑底色 / 拼合成输入) 与 IO (取回 / LLM 合成 / 落库) 分开。

import { supabase, llm, LLM_MODEL, PARAMS } from './config.js';
import { embed } from './embeddings.js';
import { readStateHistory, summarizeTrajectory, formatTrajectory } from './state/affect.js';

// ---- 纯逻辑 ----

/**
 * 从一批记忆里挑"关系底色": 只取 dyad, 按重要性降序 (并列看新近), 取前 n 条。
 * @returns 最多 n 条 dyad 记忆
 */
export function pickDyadBackdrop(mems, n = 1) {
  return (mems ?? [])
    .filter((m) => m.subject_kind === 'dyad' && !m.superseded_by)
    .sort((a, b) => {
      const di = (b.importance ?? 0) - (a.importance ?? 0);
      if (di !== 0) return di;
      return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
    })
    .slice(0, Math.max(0, n));
}

/**
 * 把 dyad 记忆 + 当前状态 + (可选)历史轨迹拼成给 LLM 合成"我们的故事"的输入文本 (可单测格式)。
 * @param trajectory summarizeTrajectory(history) 的结果, 给则附一行关系走向。
 */
export function composeNarrativeInput(dyadMems, state, trajectory = null) {
  const events = (dyadMems ?? []).map((m) => `- ${m.fact_core || m.content}${m.narrative ? ` (${m.narrative})` : ''}`);
  const rel = state?.relationship ?? {};
  const stateLine = `当前关系: 亲密度 ${fmt(rel.closeness)}, 紧张 ${fmt(rel.tension)}, 信任 ${fmt(rel.trust)}, 待和好 ${fmt(rel.repair_debt)}`;
  const trendLine = trajectory ? formatTrajectory(trajectory) : '';
  return [stateLine, trendLine, `共同经历:\n${events.join('\n') || '(还没有共同经历)'}`].filter(Boolean).join('\n');
}

// ---- IO ----

/** 取最重要的 n 条 dyad 记忆作关系底色 (给 recall 拼注入用)。 */
export async function dyadBackdrop(userId, companionId = 'default', n = PARAMS.relationship_memory.alwaysIncludeDyad) {
  if (n <= 0) return [];
  const { data, error } = await supabase
    .from('memories')
    .select('id, fact_core, content, narrative, importance, subject_kind, created_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .eq('subject_kind', 'dyad')
    .is('superseded_by', null)
    .order('importance', { ascending: false })
    .limit(n);
  if (error) throw error;
  return data ?? [];
}

/**
 * 合成"我们的故事": 拉 dyad/关系记忆 + 当前状态, LLM 写一段连贯关系叙事,
 * 作为最高层 reflection (subject_kind='dyad') 存回。
 */
export async function synthesizeNarrative(userId, companionId = 'default', state, opts = {}) {
  const lookback = opts.lookback ?? PARAMS.relationship_memory.narrativeLookback;
  const { data: mems, error } = await supabase
    .from('memories')
    .select('fact_core, content, narrative, importance, created_at')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
    .in('subject_kind', ['dyad'])
    .is('superseded_by', null)
    .order('created_at', { ascending: false })
    .limit(lookback);
  if (error) throw error;
  if (!mems || mems.length === 0) return null;

  const sys = `你在帮一个 AI 伴侣写下"我们的故事"——她对这段关系的连贯自我叙述 (narrative identity)。
基于共同经历与当前关系状态, 写一段 2-4 句、温度合适、第一人称复数("我们")的关系叙事。
忠于事实, 不要编造没发生的事。严格输出 JSON: {"story":"...","importance":1-10}。`;

  // 拉一段状态历史, 让叙事看得到关系是怎么走过来的 (feature/state-history)。
  const history = await readStateHistory(userId, companionId, { limit: opts.historyLimit ?? 50 }).catch(() => []);
  const trajectory = history.length ? summarizeTrajectory(history) : null;

  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: composeNarrativeInput(mems, state, trajectory) },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch {
    return null;
  }
  const story = String(parsed.story || '').trim();
  if (!story) return null;

  const embedding = await embed(story);
  const { data, error: e } = await supabase
    .from('memories')
    .insert({
      user_id: userId,
      companion_id: companionId,
      type: 'reflection',
      content: story,
      fact_core: story,
      narrative: null,
      subject_kind: 'dyad', // 关系叙事归"我们"
      importance: clampNum(parsed.importance, 1, 10, 8),
      emotion: 0.5,
      embedding,
    })
    .select()
    .single();
  if (e) throw e;
  return data;
}

// ---- helpers ----
function fmt(x) {
  return typeof x === 'number' ? x.toFixed(2) : '—';
}
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
