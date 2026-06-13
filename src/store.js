import { supabase, llm, LLM_MODEL } from './config.js';
import { embed, embedMany } from './embeddings.js';
import { dedupHash } from './dedup.js';

const CONTRADICT_THRESHOLD = 0.82; // 相似度高于此才送 LLM 判断是否矛盾

/**
 * 写入一批记忆。先去重 (M7), 再矛盾检测:
 *   去重: 规范化指纹命中已有记忆 → 不新增, 强化那一条 (access_count++/access_log 追加)。
 *   矛盾: 与现有某条语义冲突 ("讨厌香菜"→"喜欢香菜") → 不删旧记忆,
 *         把旧记忆 superseded_by 指向新记忆。
 */
export async function storeMemories(userId, memories) {
  if (memories.length === 0) return [];

  // M7 去重: 先算指纹, 拉同指纹的现存记忆。命中的走强化、不插入。
  const withHash = memories.map((m) => ({ m, hash: dedupHash(m.fact_core ?? m.content) }));
  const hashes = withHash.map((x) => x.hash).filter(Boolean);
  const existingByHash = await fetchByHashes(userId, hashes);

  const fresh = [];
  const reinforced = [];
  for (const { m, hash } of withHash) {
    const dup = hash ? existingByHash.get(hash) : null;
    if (dup) reinforced.push(dup);
    else fresh.push({ ...m, dedup_hash: hash });
  }
  if (reinforced.length > 0) await reinforceExisting(reinforced);
  if (fresh.length === 0) return [];

  // 向量化以"事实核"为准 (情感层不进向量空间)
  const embeddings = await embedMany(fresh.map((m) => m.fact_core ?? m.content));

  const inserted = [];
  for (let i = 0; i < fresh.length; i++) {
    const m = fresh[i];
    const embedding = embeddings[i];

    // 1) 插入新记忆 (两层本体)
    const { data, error } = await supabase
      .from('memories')
      .insert({
        user_id: userId,
        type: m.type,
        content: m.fact_core ?? m.content,   // 兼容旧列, 等于事实核
        fact_core: m.fact_core ?? m.content,
        narrative: m.narrative ?? null,
        affect_valence: m.affect_valence ?? 0,
        affect_intensity: m.affect_intensity ?? m.emotion ?? 0,
        subject_kind: m.subject_kind ?? 'user',
        fact_locked: m.fact_locked ?? false,
        // M6 多模态字段 (纯文本记忆为默认值)
        modality: m.modality ?? 'text',
        media_ref: m.media_ref ?? null,
        media_embedding: m.media_embedding ?? null,
        dedup_hash: m.dedup_hash ?? null,
        embedding,
        importance: m.importance,
        emotion: m.emotion ?? m.affect_intensity ?? 0,
      })
      .select()
      .single();
    if (error) throw error;
    inserted.push(data);

    // 2) 找语义相近的旧记忆, 判断是否被取代
    await supersedeContradictions(userId, data, embedding);
  }
  return inserted;
}

/** 拉一批指纹对应的现存(未取代)记忆, 建 hash→记忆 映射 (用于去重)。 */
async function fetchByHashes(userId, hashes) {
  const map = new Map();
  if (!hashes || hashes.length === 0) return map;
  const { data, error } = await supabase
    .from('memories')
    .select('id, dedup_hash, access_count, access_log')
    .eq('user_id', userId)
    .is('superseded_by', null)
    .in('dedup_hash', [...new Set(hashes)]);
  if (error || !data) return map;
  for (const m of data) if (!map.has(m.dedup_hash)) map.set(m.dedup_hash, m); // 同指纹留最早一条
  return map;
}

/** 重复命中 = 又被提起一次: 刷新 last_accessed、access_count++、access_log 追加时间戳。 */
async function reinforceExisting(mems) {
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

async function supersedeContradictions(userId, newMem, embedding) {
  // 取相似 top 5 (排除自己), 只看未被取代的
  const { data: candidates, error } = await supabase.rpc('match_memories', {
    p_user_id: userId,
    query_embedding: embedding,
    match_count: 6,
  });
  if (error || !candidates) return;

  const close = candidates.filter(
    (c) => c.id !== newMem.id && c.similarity >= CONTRADICT_THRESHOLD
  );
  if (close.length === 0) return;

  // 交给 LLM 判断哪些旧记忆与新记忆冲突 (而非只是同话题)
  const judged = await judgeContradictions(newMem.content, close);
  const supersededIds = judged.filter((j) => j.contradicts).map((j) => j.id);

  if (supersededIds.length > 0) {
    await supabase
      .from('memories')
      .update({ superseded_by: newMem.id })
      .in('id', supersededIds);
  }
}

async function judgeContradictions(newContent, oldMems) {
  const sys = `判断"新信息"是否取代/推翻了每条"旧信息"(即两者不能同时为真, 或新信息是旧信息的更新)。
仅当确实冲突或属于更新时才标记 contradicts=true。同一话题但不冲突的标 false。
严格输出 JSON: {"results":[{"id":"...","contradicts":true/false}]}, 不要其它内容。`;

  const list = oldMems.map((m) => ({ id: m.id, content: m.content }));
  const res = await llm.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `新信息: ${newContent}\n旧信息列表: ${JSON.stringify(list, null, 2)}`,
      },
    ],
  });

  try {
    const parsed = JSON.parse(res.choices[0].message.content);
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}
