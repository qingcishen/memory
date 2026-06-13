// M4 · persona = self 记忆 (招牌②的一半)。
//
// 记忆主体三分: user(关于你) / self(她对自己的设定) / dyad(我们共有)。
// self 就是她的人格连续设定 ——"我有点社恐""我爱吃甜的"。它必须【域隔离】:
// persona 注入只取 self, 且 self 不被 user 记忆污染 (检索关于"你"的事时不混进她自己的设定)。
//
// 纯逻辑 (筛选/格式化) 与 IO (落库/取回) 分开。

import { supabase, PARAMS } from './config.js';
import { embedMany } from './embeddings.js';
import { normalizeMemory } from './ontology.js';

// ---- 纯逻辑 ----

/** 域隔离: 从一批记忆里只保留指定 subject_kind。recall 关于"你"的事时用来剔除 self。 */
export function filterBySubject(mems, subjects) {
  if (!subjects) return mems;
  const set = new Set([].concat(subjects));
  return (mems ?? []).filter((m) => set.has(m.subject_kind ?? 'user'));
}

/** 把 self 记忆拼成可注入人格 prompt 的"她是谁"段落。 */
export function formatPersonaBlock(selfMems, subjectName = '她') {
  if (!selfMems || selfMems.length === 0) return '';
  const lines = selfMems.map((m) => `- ${m.narrative || m.fact_core || m.content}`).join('\n');
  return `${subjectName}是这样一个人:\n${lines}`;
}

// ---- IO ----

/**
 * 播种人格: 把一组"她对自己的设定"写成 self 记忆。
 * @param facts 字符串数组, 或 {fact_core, importance, fact_locked, affect} 对象数组
 */
export async function seedPersona(userId, facts = []) {
  const norm = facts
    .map((f) => normalizeMemory(typeof f === 'string' ? { fact_core: f } : f))
    .map((m) => ({ ...m, subject_kind: 'self' })); // 强制 self 域
  if (norm.length === 0) return [];

  const embeddings = await embedMany(norm.map((m) => m.fact_core));
  const rows = norm.map((m, i) => ({
    user_id: userId,
    type: m.type === 'fact' ? 'fact' : m.type,
    content: m.fact_core,
    fact_core: m.fact_core,
    narrative: m.narrative ?? null,
    affect_valence: m.affect_valence ?? 0,
    affect_intensity: m.affect_intensity ?? 0,
    subject_kind: 'self',
    fact_locked: m.fact_locked ?? false,
    embedding: embeddings[i],
    importance: m.importance,
    emotion: m.emotion ?? 0,
  }));
  const { data, error } = await supabase.from('memories').insert(rows).select();
  if (error) throw error;
  return data;
}



/** 取她当前的 self 设定并拼成 persona 注入块 (域隔离: 只取 self)。 */
export async function personaBlock(userId, subjectName = '她', opts = {}) {
  const topK = opts.topK ?? PARAMS.relationship_memory.personaTopK;
  const { data, error } = await supabase
    .from('memories')
    .select('fact_core, content, narrative, importance')
    .eq('user_id', userId)
    .eq('subject_kind', 'self')
    .is('superseded_by', null)
    .order('importance', { ascending: false })
    .limit(topK);
  if (error) throw error;
  return formatPersonaBlock(data ?? [], subjectName);
}
