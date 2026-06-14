import { supabase, llm, LLM_MODEL } from './config.js';
import { embed, embedMany } from './embeddings.js';
import { dedupHash, findNearDuplicate } from './dedup.js';

const CONTRADICT_THRESHOLD = 0.82; // 相似度高于此才送 LLM 判断是否矛盾

/**
 * 写入一批记忆。先去重 (M7), 再矛盾检测:
 *   去重: 规范化指纹命中已有记忆 → 不新增, 强化那一条 (access_count++/access_log 追加)。
 *   矛盾: 与现有某条语义冲突 ("讨厌香菜"→"喜欢香菜") → 不删旧记忆,
 *         把旧记忆 superseded_by 指向新记忆。
 */
export async function storeMemories(userId, companionId = 'default', memories) {
  if (memories.length === 0) return [];

  // M7 去重: 先算指纹, 拉同指纹的现存记忆。命中的走强化、不插入。
  const withHash = memories.map((m) => ({ m, hash: dedupHash(m.fact_core ?? m.content) }));
  const hashes = withHash.map((x) => x.hash).filter(Boolean);
  const existingByHash = await fetchByHashes(userId, companionId, hashes);

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

    // M7 近义去重: 向量上几乎重合的旧记忆 = 同一件事换了个说法 (如"讨厌香菜"/"不爱吃香菜"),
    // 强化旧记忆而不是新增一条。dedup_hash 只挡完全相同的文本, 挡不住这种情况。
    const { data: candidates } = await supabase.rpc('match_memories', {
      p_user_id: userId,
      p_companion_id: companionId,
      query_embedding: embedding,
      match_count: 6,
    });
    const nearDup = findNearDuplicate(candidates ?? []);
    if (nearDup) {
      await reinforceExisting([nearDup]);
      continue;
    }

    // 1) 插入新记忆 (两层本体)
    const { data, error } = await supabase
      .from('memories')
      .insert({
        user_id: userId,
        companion_id: companionId,
        type: m.type,
        content: m.fact_core ?? m.content,   // 兼容旧列, 等于事实核
        fact_core: m.fact_core ?? m.content,
        narrative: m.narrative ?? null,
        affect_valence: m.affect_valence ?? 0,
        affect_intensity: m.affect_intensity ?? m.emotion ?? 0,
        // 原始情感锚 = 诞生时的情感, 写入后不可变 (重构靠它回弹)
        affect_origin_valence: m.affect_valence ?? 0,
        affect_origin_intensity: m.affect_intensity ?? m.emotion ?? 0,
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
    if (error) {
      // #10 并发写入: 两个并发 observe() 都没在 fetchByHashes 里看到对方 (都还没提交),
      // 都判定 fresh —— 后提交的撞上 memories_dedup_unique_idx 抛 23505。
      // 退化为强化先提交的那条 (乐观重试), 而不是抛错丢掉这一轮提取。
      const conflict = resolveInsertConflict(error, m.dedup_hash, await fetchByHashes(userId, companionId, [m.dedup_hash]));
      if (conflict.retry) {
        await reinforceExisting([conflict.reinforce]);
        continue;
      }
      throw error;
    }
    inserted.push(data);

    // 2) 找语义相近的旧记忆, 判断是否被取代 (复用刚才查到的候选, 不再多查一次)
    await supersedeContradictions(data, candidates ?? []);
  }
  return inserted;
}

/** 拉一批指纹对应的现存(未取代)记忆, 建 hash→记忆 映射 (用于去重)。 */
async function fetchByHashes(userId, companionId, hashes) {
  const map = new Map();
  if (!hashes || hashes.length === 0) return map;
  const { data, error } = await supabase
    .from('memories')
    .select('id, dedup_hash, access_count, access_log')
    .eq('user_id', userId)
    .eq('companion_id', companionId)
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

async function supersedeContradictions(newMem, candidates) {
  // candidates 是插入前查到的相似列表 (此时 newMem 尚不在库里, 不会出现自身)。
  const close = candidates.filter((c) => c.id !== newMem.id && c.similarity >= CONTRADICT_THRESHOLD);
  if (close.length === 0) return;

  // 交给 LLM 判断哪些旧记忆与新记忆冲突 (而非只是同话题)
  const judged = await judgeContradictions(newMem.content, close);
  const supersededIds = judged.filter((j) => j.contradicts).map((j) => j.id);

  if (supersededIds.length > 0) {
    // #10 并发写入: 只在仍未被取代时落子。两个并发新记忆都判定要取代同一条旧记忆时,
    // 先到的更新生效, 后到的影响 0 行而不是覆盖 superseded_by —— 取代链不会被乱序覆写。
    await supabase
      .from('memories')
      .update({ superseded_by: newMem.id })
      .in('id', supersededIds)
      .is('superseded_by', null);
  }
}

/** Postgres 唯一约束冲突 (23505) —— 并发 observe 同时插入了同一指纹的记忆。 */
export function isUniqueViolation(error) {
  return error?.code === '23505';
}

/**
 * #10 工程债 (事务与并发写入): insert 撞上 memories_dedup_unique_idx 时如何处理。
 * existingByHash 是冲突后重新 fetchByHashes 拿到的现存记忆映射 (hash → 记忆)。
 * 返回 { retry: true, reinforce } 表示转去强化抢先插入的那条;
 * 返回 { retry: false } 表示这不是可恢复的冲突, 应照常抛出原始错误。
 */
export function resolveInsertConflict(error, dedupHash, existingByHash) {
  if (!isUniqueViolation(error) || !dedupHash) return { retry: false };
  const existing = existingByHash.get(dedupHash);
  if (!existing) return { retry: false };
  return { retry: true, reinforce: existing };
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
