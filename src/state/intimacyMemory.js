// I-3 · 亲密场景记忆。
//
// 这类记忆与普通 dyad 记忆共用 memories 表，但有更严格的隐私边界：
// - 只根据 IntimacyDimension 的权威 before/after 快照生成，不读取对话正文；
// - 只在亲密召回上下文中可见；
// - 使用事件键（或状态时间锚）做跨进程幂等。

import { supabase } from '../config.js';
import { embed } from '../embeddings.js';
import { dedupHash } from '../dedup.js';

export const INTIMATE_MEMORY_TYPE = 'intimate_memory';
export const INTIMATE_MEMORY_PHASES = ['peak', 'aftercare'];

const INTIMATE_RECALL_PHASES = new Set(['flirting', 'foreplay', 'peak', 'aftercare']);

const SAFE_PHASE_SUMMARIES = {
  peak: '双方在一次亲密互动中进入了更深的亲密阶段。',
  aftercare: '双方在亲密互动后进入了相互陪伴与安抚的余韵阶段。',
};

const SAFE_PHASE_NARRATIVES = {
  peak: '这是一段只适合在亲密情境中回想的共同经历。',
  aftercare: '那次亲密之后，彼此留在身边照顾了余韵。',
};

/** 只在 phase 确实发生迁移且首次进入目标 phase 时产生事件。 */
export function detectIntimateMemoryTransition(before = {}, after = {}) {
  const from = normalizePhase(before?.scene_phase);
  const to = normalizePhase(after?.scene_phase);
  if (from === to || !INTIMATE_MEMORY_PHASES.includes(to)) return null;
  return { from, to };
}

/**
 * 从权威状态迁移构造安全记忆。函数签名刻意不接收 turns/text，避免显式正文误入存储。
 * eventId 优先；缺失时退回亲密状态的时间锚，仍可在同一状态迁移重放时稳定去重。
 */
export function buildIntimateMemoryRecord({ before = {}, after = {}, eventId = null, now = Date.now() } = {}) {
  const transition = detectIntimateMemoryTransition(before, after);
  if (!transition) return null;

  const anchor =
    cleanOpaqueId(eventId) ||
    cleanTimestamp(before?.updated_at) ||
    cleanTimestamp(after?.updated_at) ||
    cleanTimestamp(after?.last_intimate_at) ||
    new Date(normalizeNow(now)).toISOString();
  const idempotencyKey = dedupHash(
    `intimate-memory:v1:${anchor}:${transition.from}->${transition.to}`,
  );

  return {
    type: INTIMATE_MEMORY_TYPE,
    fact_core: SAFE_PHASE_SUMMARIES[transition.to],
    content: SAFE_PHASE_SUMMARIES[transition.to],
    narrative: SAFE_PHASE_NARRATIVES[transition.to],
    subject_kind: 'dyad',
    importance: 5,
    affect_valence: 0.25,
    affect_intensity: transition.to === 'peak' ? 0.65 : 0.45,
    emotion: transition.to === 'peak' ? 0.65 : 0.45,
    fact_locked: true,
    transition,
    idempotency_key: idempotencyKey,
  };
}

/** 把安全记录转换成 memories 表行；source 只含结构化元数据，不含用户/助手正文。 */
export function toIntimateMemoryRow(userId, companionId = 'default', record, embedding = null) {
  if (!userId) throw new Error('亲密记忆需要 userId');
  if (!record || record.type !== INTIMATE_MEMORY_TYPE || !record.idempotency_key) {
    throw new Error('无效的亲密记忆记录');
  }
  return {
    user_id: userId,
    companion_id: companionId,
    type: INTIMATE_MEMORY_TYPE,
    content: record.fact_core,
    fact_core: record.fact_core,
    narrative: record.narrative,
    affect_valence: record.affect_valence,
    affect_intensity: record.affect_intensity,
    affect_origin_valence: record.affect_valence,
    affect_origin_intensity: record.affect_intensity,
    subject_kind: 'dyad',
    fact_locked: true,
    modality: 'text',
    media_ref: null,
    media_embedding: null,
    dedup_hash: record.idempotency_key,
    embedding,
    importance: record.importance,
    emotion: record.emotion,
    source: {
      kind: INTIMATE_MEMORY_TYPE,
      version: 1,
      transition: `${record.transition.from}->${record.transition.to}`,
      idempotency_key: record.idempotency_key,
    },
  };
}

/**
 * 默认生产写入器。insertFn/embedFn 可注入，定向测试无需网络。
 * memories_dedup_unique_idx 以 idempotency_key 派生的 dedup_hash 拦截并发重放。
 */
export async function storeIntimateMemory(
  userId,
  companionId = 'default',
  record,
  { embedFn = embed, insertFn = null } = {},
) {
  if (!record) return [];
  const embedding = await embedFn(record.fact_core);
  const row = toIntimateMemoryRow(userId, companionId, record, embedding);

  if (typeof insertFn === 'function') {
    const inserted = await insertFn(row);
    return inserted ? [inserted] : [];
  }

  const { data, error } = await supabase
    .from('memories')
    .insert(row)
    .select()
    .single();
  // 同 eventId/迁移的并发或重放命中唯一索引，视为已经成功记录。
  if (error?.code === '23505') return [];
  if (error) throw error;
  return data ? [data] : [];
}

export function isIntimateMemory(memory) {
  return memory?.type === INTIMATE_MEMORY_TYPE;
}

/** 亲密场景可以显式传 intimate=true，也可由场景/当前 phase 判定。 */
export function isIntimateRecallContext(opts = {}) {
  return (
    opts?.intimate === true ||
    opts?.intimateRecall === true ||
    opts?.sceneType === 'intimate' ||
    INTIMATE_RECALL_PHASES.has(opts?.intimacyPhase)
  );
}

/** 非亲密上下文必须剔除；这是 RPC/底色过滤之外的应用层隐私兜底。 */
export function filterIntimateMemories(memories = [], opts = {}) {
  const rows = Array.isArray(memories) ? memories : [];
  return isIntimateRecallContext(opts)
    ? rows
    : rows.filter((memory) => !isIntimateMemory(memory));
}

/** 亲密上下文中稳定地把专属记忆排在普通候选之前，不改写候选分数或对象。 */
export function prioritizeIntimateMemories(memories = [], opts = {}) {
  const rows = filterIntimateMemories(memories, opts);
  if (!isIntimateRecallContext(opts)) return rows;
  const intimate = [];
  const other = [];
  for (const memory of rows) {
    (isIntimateMemory(memory) ? intimate : other).push(memory);
  }
  return [...intimate, ...other];
}

/**
 * 已由权威 phase 迁移生成安全摘要时，丢弃同轮 LLM 可能抽出的普通 dyad episode。
 * 这样显式场景正文不会再经通用 episode 路径旁路落库；偏好/硬边界仍按原管线保留。
 */
export function removeUnsafeIntimateEpisodes(memories = [], intimateRecord = null) {
  const rows = Array.isArray(memories) ? memories : [];
  if (!intimateRecord) return rows;
  return rows.filter(
    (memory) =>
      !(memory?.type === 'episode' && memory?.subject_kind === 'dyad'),
  );
}

function normalizePhase(value) {
  const phase = String(value ?? 'none').trim();
  return phase || 'none';
}

function cleanOpaqueId(value) {
  const id = String(value ?? '').trim();
  if (!id) return null;
  // 事件 ID 只参与哈希，不进入 fact/narrative/source 明文。
  return `event:${id.slice(0, 512)}`;
}

function cleanTimestamp(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeNow(value) {
  const raw = typeof value === 'function' ? value() : value;
  const time = new Date(raw ?? Date.now()).getTime();
  return Number.isFinite(time) ? time : Date.now();
}
