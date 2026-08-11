// M-5 · 跨会话工作记忆。
//
// CEE 的沉默期私有记忆会以短期 working_memory 投影到主 memories 表：
// - 48 小时内作为下一场会话的桥，语境权重 ×1.3；
// - 过期后保留事实，不再强制桥接，激活层按普通 episode 降权；
// - consolidation key 派生 dedup_hash，保证心跳重试/多进程投影幂等。

import { supabase } from '../config.js';
import { dedupHash } from '../dedup.js';
import { embed } from '../embeddings.js';
import { sanitizeForPrompt } from '../promptSafety.js';

export const WORKING_MEMORY_TYPE = 'working_memory';
export const WORKING_MEMORY_TTL_MS = 48 * 60 * 60 * 1000;
export const WORKING_MEMORY_CONTEXT_MULTIPLIER = 1.3;

/** 从 CEE 私有记忆构造主记忆投影；不接受 turns，避免再次运行通用提取器。 */
export function buildWorkingMemoryRecord(input = {}, opts = {}) {
  const content = sanitizeForPrompt(input.content).slice(0, 240);
  const idempotencyAnchor = String(
    input.idempotencyKey ?? input.idempotency_key ?? opts.eventId ?? '',
  ).trim();
  if (!content || !idempotencyAnchor) return null;

  const createdAt = validIso(
    input.createdAt ?? input.created_at ?? opts.now ?? Date.now(),
  );
  if (!createdAt) return null;
  const valence = clampSigned(
    input.emotionalValence ?? input.emotional_valence ?? input.affect_valence,
  );
  const intensity = clamp01(
    input.emotionalIntensity ??
      input.emotional_intensity ??
      Math.max(0.35, Math.abs(valence)),
  );
  const idempotencyKey = dedupHash(
    `working-memory:v1:${idempotencyAnchor}`,
  );
  if (!idempotencyKey) return null;

  return {
    type: WORKING_MEMORY_TYPE,
    fact_core: content,
    content,
    narrative: content,
    subject_kind: 'user',
    importance: 4,
    affect_valence: valence,
    affect_intensity: intensity,
    emotion: intensity,
    fact_locked: false,
    created_at: createdAt,
    expires_at: new Date(
      new Date(createdAt).getTime() + WORKING_MEMORY_TTL_MS,
    ).toISOString(),
    idempotency_key: idempotencyKey,
  };
}

/** memories 表写入协议。source 只保留结构化生命周期信息，不保存原始 turns。 */
export function toWorkingMemoryRow(
  userId,
  companionId = 'default',
  record,
  embedding = null,
) {
  if (!String(userId ?? '').trim()) {
    throw new Error('工作记忆需要 userId');
  }
  if (
    !record ||
    record.type !== WORKING_MEMORY_TYPE ||
    !record.idempotency_key
  ) {
    throw new Error('无效的工作记忆记录');
  }
  return {
    user_id: String(userId),
    companion_id: String(companionId || 'default'),
    type: WORKING_MEMORY_TYPE,
    content: record.fact_core,
    fact_core: record.fact_core,
    narrative: record.narrative,
    affect_valence: record.affect_valence,
    affect_intensity: record.affect_intensity,
    affect_origin_valence: record.affect_valence,
    affect_origin_intensity: record.affect_intensity,
    subject_kind: record.subject_kind,
    fact_locked: false,
    modality: 'text',
    media_ref: null,
    media_embedding: null,
    dedup_hash: record.idempotency_key,
    embedding,
    importance: record.importance,
    emotion: record.emotion,
    created_at: record.created_at,
    source: {
      kind: WORKING_MEMORY_TYPE,
      version: 1,
      lifecycle: '48h_bridge_then_episode',
      expires_at: record.expires_at,
      idempotency_key: record.idempotency_key,
    },
  };
}

/** 生产写入器；23505 表示同一次 consolidation 已投影，按幂等成功处理。 */
export async function storeWorkingMemory(
  userId,
  companionId = 'default',
  record,
  { embedFn = embed, insertFn = null } = {},
) {
  if (!record) return [];
  const embedding = await embedFn(record.fact_core);
  const row = toWorkingMemoryRow(userId, companionId, record, embedding);

  if (typeof insertFn === 'function') {
    const inserted = await insertFn(row);
    return inserted ? [inserted] : [];
  }

  const { data, error } = await supabase
    .from('memories')
    .insert(row)
    .select()
    .single();
  if (error?.code === '23505') return [];
  if (error) throw error;
  return data ? [data] : [];
}

/** 48h 生命周期只看 created_at，不因 recall 刷新 last_accessed 而无限续期。 */
export function isFreshWorkingMemory(
  memory,
  now = Date.now(),
  ttlMs = WORKING_MEMORY_TTL_MS,
) {
  if (memory?.type !== WORKING_MEMORY_TYPE) return false;
  const createdAt = timeMs(memory.created_at);
  const current = timeMs(now);
  const ttl = Number(ttlMs);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(current) ||
    !Number.isFinite(ttl) ||
    ttl <= 0
  ) {
    return false;
  }
  const age = current - createdAt;
  return age >= 0 && age < ttl;
}

/** 激活层使用：新鲜工作记忆保留类型；过期后按 episode 计算时间惩罚。 */
export function effectiveMemoryType(memory, now = Date.now()) {
  if (memory?.type !== WORKING_MEMORY_TYPE) return memory?.type ?? null;
  return isFreshWorkingMemory(memory, now)
    ? WORKING_MEMORY_TYPE
    : 'episode';
}

export function workingMemoryContextMultiplier(memory, now = Date.now()) {
  return isFreshWorkingMemory(memory, now)
    ? WORKING_MEMORY_CONTEXT_MULTIPLIER
    : 1;
}

/** 新会话桥只挑 48h 内工作记忆，按最近生成优先。 */
export function selectWorkingMemoryBridge(memories = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? WORKING_MEMORY_TTL_MS;
  const limit = Math.max(0, Math.floor(Number(opts.limit ?? opts.topK ?? 3)));
  return (Array.isArray(memories) ? memories : [])
    .filter((memory) => isFreshWorkingMemory(memory, now, ttlMs))
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, limit);
}

/**
 * 从主 memories 表读取下一场会话的桥。loader 可注入，测试无需数据库。
 * 这里只读 type=working_memory；过期行仍留在库中，之后由普通向量 recall 按 episode 对待。
 */
export async function loadWorkingMemoryBridge(
  userId,
  companionId = 'default',
  opts = {},
) {
  const now = timeMs(opts.now ?? Date.now());
  if (!Number.isFinite(now)) return [];
  const ttlMs = Number(opts.ttlMs ?? WORKING_MEMORY_TTL_MS);
  const limit = Math.max(1, Math.min(20, Number(opts.limit ?? opts.topK ?? 3)));
  let rows;
  if (typeof opts.loader === 'function') {
    rows = await opts.loader({
      userId,
      companionId,
      now,
      ttlMs,
      limit,
    });
  } else {
    const cutoff = new Date(now - ttlMs).toISOString();
    const { data, error } = await supabase
      .from('memories')
      .select(
        'id,type,content,fact_core,narrative,subject_kind,importance,emotion,created_at,last_accessed,access_count,access_log',
      )
      .eq('user_id', userId)
      .eq('companion_id', companionId)
      .eq('type', WORKING_MEMORY_TYPE)
      .is('superseded_by', null)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    rows = data ?? [];
  }
  return selectWorkingMemoryBridge(rows, { now, ttlMs, limit });
}

function validIso(value) {
  const timestamp = timeMs(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value == null || value === '') return NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function clampSigned(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(-1, Math.min(1, number))
    : 0;
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, Math.min(1, number))
    : 0;
}
