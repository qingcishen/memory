import { createHash } from 'node:crypto';
import { BeliefEvidenceSchema, BeliefRecordSchema } from './schema.js';

export const BELIEF_KINDS = Object.freeze([
  'identity',
  'preference',
  'event',
  'commitment',
  'relationship',
  'general',
]);

export const EPISTEMIC_STATUSES = Object.freeze(['asserted', 'inferred', 'uncertain']);
export const EVIDENCE_SOURCE_KINDS = Object.freeze([
  'user',
  'assistant',
  'external',
  'inference',
  'memory',
  'system',
]);

/**
 * 将显式的结构化信念规范化。不会从自然语言猜 subject/predicate/object。
 * 对“助手声称的用户事实”自动降为 inferred，防止助手编造反向污染用户画像。
 */
export function normalizeBelief(raw = {}, defaults = {}) {
  const subjectKey = normalizeKey(raw.subjectKey ?? raw.subject_key ?? defaults.subjectKey);
  const subjectLabel = cleanText(raw.subjectLabel ?? raw.subject_label ?? defaults.subjectLabel ?? subjectKey);
  const predicate = normalizePredicate(raw.predicate);
  const objectValue = normalizeObject(raw.objectValue ?? raw.object_value ?? raw.object);
  const objectText = cleanText(raw.objectText ?? raw.object_text ?? objectToText(objectValue));
  if (!subjectKey || !subjectLabel || !predicate || !objectText) {
    throw codedError('belief requires subject, predicate and object', 'BELIEF_INVALID');
  }

  const sourceKind = normalizeSourceKind(raw.sourceKind ?? raw.source_kind ?? defaults.sourceKind);
  let epistemicStatus = EPISTEMIC_STATUSES.includes(raw.epistemicStatus ?? raw.epistemic_status)
    ? raw.epistemicStatus ?? raw.epistemic_status
    : sourceKind === 'inference'
      ? 'inferred'
      : 'asserted';
  let confidence = clamp01(raw.confidence ?? defaults.confidence ?? defaultConfidence(sourceKind));

  // assistant 可以陈述自己的 self 信念，但不能把关于 user 的陈述升级成 asserted。
  const isUserSubject = subjectKey === 'user' || subjectKey.startsWith('user:');
  if (sourceKind === 'assistant' && isUserSubject) {
    epistemicStatus = 'inferred';
    confidence = Math.min(confidence, 0.49);
  }

  const normalized = {
    subject_key: subjectKey,
    subject_label: subjectLabel,
    predicate,
    object_value: objectValue,
    object_text: objectText,
    belief_kind: BELIEF_KINDS.includes(raw.beliefKind ?? raw.belief_kind)
      ? raw.beliefKind ?? raw.belief_kind
      : 'general',
    epistemic_status: epistemicStatus,
    confidence,
    slot_key: normalizeSlotKey(raw.slotKey ?? raw.slot_key),
    valid_from: isoOrNull(raw.validFrom ?? raw.valid_from),
    valid_to: isoOrNull(raw.validTo ?? raw.valid_to),
    metadata: plainObject(raw.metadata),
  };
  normalized.belief_key = raw.beliefKey ?? raw.belief_key ?? beliefKey(normalized);
  return BeliefRecordSchema.parse(normalized);
}

export function normalizeEvidence(raw = {}, defaults = {}) {
  const sourceKind = normalizeSourceKind(raw.sourceKind ?? raw.source_kind ?? defaults.sourceKind);
  const evidenceText = cleanText(raw.evidenceText ?? raw.evidence_text ?? defaults.evidenceText);
  const sourceId = cleanText(raw.sourceId ?? raw.source_id ?? defaults.sourceId) || null;
  const sourceMemoryId =
    cleanText(raw.sourceMemoryId ?? raw.source_memory_id ?? defaults.sourceMemoryId) || null;
  const observedAt = isoOrNull(raw.observedAt ?? raw.observed_at ?? defaults.observedAt) ??
    new Date().toISOString();
  const fingerprint = JSON.stringify({
    sourceKind,
    sourceId,
    sourceMemoryId,
    evidenceText,
    supports: raw.supports !== false,
  });
  return BeliefEvidenceSchema.parse({
    source_kind: sourceKind,
    source_id: sourceId,
    source_memory_id: sourceMemoryId,
    evidence_text: evidenceText || null,
    evidence_hash: raw.evidenceHash ?? raw.evidence_hash ?? sha256(fingerprint),
    supports: raw.supports !== false,
    confidence: clamp01(raw.confidence ?? defaults.confidence ?? defaultConfidence(sourceKind)),
    observed_at: observedAt,
    metadata: plainObject(raw.metadata),
  });
}

export function beliefKey(belief) {
  return sha256(
    JSON.stringify([
      normalizeKey(belief.subject_key ?? belief.subjectKey),
      normalizePredicate(belief.predicate),
      canonicalObject(belief.object_value ?? belief.objectValue ?? belief.object),
    ]),
  );
}

export function sameBelief(a, b) {
  return beliefKey(a) === beliefKey(b);
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalObject(value[key])]),
    );
  }
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : value;
}

function normalizeObject(value) {
  if (value == null) throw codedError('belief object cannot be null', 'BELIEF_INVALID');
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(normalizeObject);
  if (typeof value === 'object') return canonicalObject(value);
  return String(value);
}

function objectToText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function normalizePredicate(value) {
  return normalizeKey(value).replace(/:/g, '_');
}

function normalizeSlotKey(value) {
  const text = normalizeKey(value);
  return text || null;
}

function normalizeSourceKind(value) {
  return EVIDENCE_SOURCE_KINDS.includes(value) ? value : 'inference';
}

function normalizeKey(value) {
  return cleanText(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_:.-]/gu, '');
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw codedError('invalid belief timestamp', 'BELIEF_TIME_INVALID');
  return date.toISOString();
}

function defaultConfidence(sourceKind) {
  if (sourceKind === 'user') return 0.9;
  if (sourceKind === 'external') return 0.8;
  if (sourceKind === 'assistant') return 0.65;
  if (sourceKind === 'memory') return 0.7;
  return 0.5;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
