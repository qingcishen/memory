// K1 · 知识图谱落库: 实体 upsert (按 user+companion+entity_key 幂等) + 关系 upsert。
//
// 表结构见 sql/knowledge-graph.sql。实体带 canonical_name 的向量 (入口召回用);
// 同一三元组重复出现时更新置信度/依据而不是新增行 (唯一约束兜底)。

import { supabase, PARAMS } from '../config.js';
import { embedMany } from '../embeddings.js';
import { extractKnowledge } from './extract.js';

/** 实体 upsert, 返回 entity_key -> id 的映射。 */
export async function upsertEntities(userId, companionId, entities = []) {
  if (entities.length === 0) return new Map();
  // 实体名向量给 match_knowledge_entities 做入口召回; embedding 失败时仍落名字 (可后补)
  const embeddings = await embedMany(entities.map((e) => e.name)).catch(() => null);
  const now = new Date().toISOString();
  const rows = entities.map((e, i) => ({
    user_id: userId,
    companion_id: companionId,
    entity_key: e.key,
    canonical_name: e.name,
    entity_type: e.type,
    aliases: e.aliases ?? [],
    ...(embeddings?.[i] ? { embedding: embeddings[i] } : {}),
    updated_at: now,
  }));
  const { data, error } = await supabase
    .from('knowledge_entities')
    .upsert(rows, { onConflict: 'user_id,companion_id,entity_key' })
    .select('id, entity_key');
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.entity_key, r.id]));
}

/** 关系 upsert (同三元组更新置信度/依据), 返回写入条数。 */
export async function upsertRelations(userId, companionId, relations = [], idByKey = new Map(), sourceMemoryId = null) {
  const now = new Date().toISOString();
  const rows = relations
    .filter((r) => idByKey.has(r.sourceKey) && idByKey.has(r.targetKey))
    .map((r) => ({
      user_id: userId,
      companion_id: companionId,
      source_entity_id: idByKey.get(r.sourceKey),
      relation: r.relation,
      target_entity_id: idByKey.get(r.targetKey),
      confidence: r.confidence,
      evidence: r.evidence,
      ...(sourceMemoryId ? { source_memory_id: sourceMemoryId } : {}),
      status: 'active',
      updated_at: now,
    }))
    // check 约束 source<>target: 同名实体归一后可能撞车, 直接丢弃
    .filter((r) => r.source_entity_id !== r.target_entity_id);
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from('knowledge_relations')
    .upsert(rows, { onConflict: 'user_id,companion_id,source_entity_id,relation,target_entity_id' });
  if (error) throw error;
  return rows.length;
}

/**
 * observe 的图谱分支: 对话 -> 抽取 -> 落库。返回 { entities, relations } 计数;
 * 关闭开关或没抽到东西时零 DB 调用。调用方 (Memory.observe) 自带 catch 失败隔离。
 */
export async function observeKnowledge(userId, companionId, turns, { subjectName, companionName } = {}) {
  if (!PARAMS.knowledge.enabled) return null;
  const { entities, relations } = await extractKnowledge(turns, { subjectName, companionName });
  if (entities.length === 0) return { entities: 0, relations: 0 };
  const idByKey = await upsertEntities(userId, companionId, entities);
  const written = await upsertRelations(userId, companionId, relations, idByKey);
  return { entities: idByKey.size, relations: written };
}
