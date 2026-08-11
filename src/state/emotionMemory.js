// E-5 · 高强度情绪事件记忆。
//
// emotionJournal 的 cause 可能是整段用户原文，因此本模块绝不把 cause 原样写入 memories。
// 事实核只由受控标签和原因类别组成；eventId 只用于派生幂等指纹。

import { supabase } from '../config.js';
import { dedupHash } from '../dedup.js';
import { embed } from '../embeddings.js';
import { EMOTION_LABELS } from './emotionLabel.js';

export const EMOTION_MEMORY_TYPE = 'emotion_event';
export const EMOTION_MEMORY_MIN_INTENSITY = 0.7;

const INTIMATE_PHASES = new Set(['flirting', 'foreplay', 'peak', 'aftercare']);

const LABEL_VALENCE = {
  平静: 0,
  开心: 0.75,
  委屈: -0.65,
  吃醋: -0.4,
  生气: -0.8,
  失落: -0.65,
  撒娇: 0.45,
  心疼: -0.3,
  期待: 0.55,
  担心: -0.55,
  害羞: 0.25,
  暧昧: 0.45,
  感动: 0.7,
  无聊: -0.35,
  骄傲: 0.65,
  烦躁: -0.6,
};

const POSITIVE_LABELS = new Set([
  '开心',
  '撒娇',
  '期待',
  '害羞',
  '暧昧',
  '感动',
  '骄傲',
]);

/**
 * journal 使用 toLabel；公共 observe 契约使用 label。这里兼容两者，但只接受受控标签。
 */
export function normalizeEmotionMemoryEvent(event = {}) {
  const label = String(event?.label ?? event?.toLabel ?? '').trim();
  const intensity = Number(event?.intensity);
  if (!EMOTION_LABELS.includes(label) || !Number.isFinite(intensity)) return null;
  return {
    label,
    intensity: clamp(intensity, 0, 1),
    at: normalizeTimestamp(event?.at),
    cause: String(event?.cause ?? ''),
  };
}

/** 情绪标签到记忆 valence；返回值始终在 -1..1。 */
export function emotionMemoryValence(label) {
  return clamp(Number(LABEL_VALENCE[label]) || 0, -1, 1);
}

/**
 * 只识别原因类别，不返回原始 cause 的任何片段。
 * 分类失败时使用通用描述，避免 prompt 注入、显式内容或个人信息旁路落库。
 */
export function classifySafeEmotionCause(cause, { intimate = false } = {}) {
  if (intimate) return '一次亲密互动';
  const text = String(cause ?? '');
  if (/(对不起|抱歉|原谅|和好|说开)/u.test(text)) return '一次关系修复';
  if (/(不回|不理|冷落|忘了|消失|已读不回)/u.test(text)) return '一次被冷落的感受';
  if (/(争吵|吵架|冲突|骂|太过分|生气)/u.test(text)) return '一次关系冲突';
  if (/(回来|见面|重逢|终于见到)/u.test(text)) return '一次重逢';
  if (/(关心|照顾|陪伴|安慰|抱抱)/u.test(text)) return '一次被关心的时刻';
  if (/(成功|通过|拿到|完成|做到了|获奖)/u.test(text)) return '一次值得庆祝的进展';
  return '一次对话互动';
}

/**
 * 从本轮新产生的 journal event 构造安全记忆。
 * eventId 优先作为幂等锚；journal at 是兼容旧调用方的稳定后备。
 */
export function buildEmotionMemoryRecord({
  emotionEvent = null,
  eventId = null,
  sceneType = null,
  intimacyPhase = null,
  now = Date.now(),
} = {}) {
  const event = normalizeEmotionMemoryEvent(emotionEvent);
  if (!event || event.intensity < EMOTION_MEMORY_MIN_INTENSITY) return null;

  const anchor =
    cleanOpaqueId(eventId) ||
    event.at ||
    new Date(normalizeNow(now)).toISOString();
  const idempotencyKey = dedupHash(`emotion-event:v1:${anchor}`);
  const intimate =
    sceneType === 'intimate' ||
    INTIMATE_PHASES.has(String(intimacyPhase ?? ''));
  const causeCategory = classifySafeEmotionCause(event.cause, { intimate });
  const fact = `${causeCategory}让她感到${event.label}，这份情绪很强烈。`;
  const narrative = POSITIVE_LABELS.has(event.label)
    ? '这段经历留下了清晰而温暖的情绪回响。'
    : event.label === '平静'
      ? '这段经历让心绪重新安定下来。'
      : '这段经历留下了需要被温柔理解的情绪回响。';

  return {
    type: EMOTION_MEMORY_TYPE,
    fact_core: fact,
    content: fact,
    narrative,
    subject_kind: 'dyad',
    importance: clamp(5 + event.intensity * 3, 1, 10),
    affect_valence: emotionMemoryValence(event.label),
    affect_intensity: event.intensity,
    emotion: event.intensity,
    fact_locked: false,
    emotion_label: event.label,
    cause_category: causeCategory,
    idempotency_key: idempotencyKey,
  };
}

/** 转成 memories 表行。source 仅含受控结构化元数据，不含 eventId 或 cause 原文。 */
export function toEmotionMemoryRow(userId, companionId = 'default', record, embedding = null) {
  if (!userId) throw new Error('情绪事件记忆需要 userId');
  if (!record || record.type !== EMOTION_MEMORY_TYPE || !record.idempotency_key) {
    throw new Error('无效的情绪事件记忆');
  }
  return {
    user_id: userId,
    companion_id: companionId,
    type: EMOTION_MEMORY_TYPE,
    content: record.fact_core,
    fact_core: record.fact_core,
    narrative: record.narrative,
    affect_valence: record.affect_valence,
    affect_intensity: record.affect_intensity,
    affect_origin_valence: record.affect_valence,
    affect_origin_intensity: record.affect_intensity,
    subject_kind: 'dyad',
    fact_locked: false,
    modality: 'text',
    media_ref: null,
    media_embedding: null,
    dedup_hash: record.idempotency_key,
    embedding,
    importance: record.importance,
    emotion: record.emotion,
    source: {
      kind: EMOTION_MEMORY_TYPE,
      version: 1,
      emotion_label: record.emotion_label,
      cause_category: record.cause_category,
      idempotency_key: record.idempotency_key,
    },
  };
}

/**
 * 默认生产写入器。唯一索引令同一 eventId 的并发投递/worker 重放成为成功的空写。
 * embedFn/insertFn 可注入，离线测试不需要网络。
 */
export async function storeEmotionMemory(
  userId,
  companionId = 'default',
  record,
  { embedFn = embed, insertFn = null } = {},
) {
  if (!record) return [];
  const embedding = await embedFn(record.fact_core);
  const row = toEmotionMemoryRow(userId, companionId, record, embedding);

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

export function isEmotionEventMemory(memory) {
  return memory?.type === EMOTION_MEMORY_TYPE;
}

function cleanOpaqueId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200 || /[\u0000-\u001f]/u.test(text)) return null;
  return text;
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeNow(value) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : Date.now();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
