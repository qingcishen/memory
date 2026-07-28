const DEFAULT_MAX_CHARS = 2200;
const DEFAULT_MAX_ITEMS = 7;

/**
 * 在检索排序之后做上下文预算选择。它不改变召回算法，只决定哪些证据值得占用 Prompt。
 * 采用可解释的 utility / cost 贪心，并优先保留硬事实。
 */
export function selectEvidenceBudget(items = [], options = {}) {
  const maxChars = positiveInt(options.maxChars, DEFAULT_MAX_CHARS);
  const maxItems = positiveInt(options.maxItems, DEFAULT_MAX_ITEMS);
  const now = Number(options.now ?? Date.now());
  const seen = new Set();
  const candidates = (items ?? [])
    .map((item, index) => scoreEvidence(item, { index, now }))
    .filter((candidate) => {
      if (!candidate.text || seen.has(candidate.dedupKey)) return false;
      seen.add(candidate.dedupKey);
      return true;
    });

  candidates.sort((a, b) =>
    Number(b.mandatory) - Number(a.mandatory) ||
    b.utilityPerChar - a.utilityPerChar ||
    b.utility - a.utility ||
    a.index - b.index);

  const selected = [];
  const dropped = [];
  let usedChars = 0;
  for (const candidate of candidates) {
    const overItems = selected.length >= maxItems;
    const overChars = usedChars + candidate.charCost > maxChars;
    // 首条硬事实允许突破预算，避免极小配置把唯一关键事实删光。
    const forced = candidate.mandatory && selected.length === 0;
    if (!forced && (overItems || overChars)) {
      dropped.push(toDecision(candidate, overItems ? 'item_budget' : 'char_budget'));
      continue;
    }
    selected.push(candidate);
    usedChars += candidate.charCost;
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.index));
  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.index) && !dropped.some((row) => row.index === candidate.index)) {
      dropped.push(toDecision(candidate, 'lower_utility'));
    }
  }

  return {
    selected: selected.map((candidate) => candidate.item),
    decisions: selected.map((candidate) => toDecision(candidate, candidate.mandatory ? 'mandatory' : 'selected')),
    dropped,
    budget: {
      maxChars,
      maxItems,
      usedChars,
      selectedCount: selected.length,
      droppedCount: dropped.length,
      estimatedTokens: Math.ceil(usedChars / 4),
    },
  };
}

export function scoreEvidence(item = {}, { index = 0, now = Date.now() } = {}) {
  const text = evidenceText(item);
  const relevance = clamp01(
    item._activation ?? item._score ?? item.similarity ?? item.relevance ?? 0,
  );
  const necessity = item.fact_locked
    ? 1
    : item.type === 'preference' || item.type === 'relationship'
      ? 0.65
      : 0.35;
  const confidence = item._lowConfidence
    ? 0.35
    : clamp01(item._confidence ?? item.confidence ?? 0.72);
  const freshness = freshnessScore(item.created_at ?? item.last_confirmed_at, now);
  const contradictionRisk =
    item.superseded_by || item.status === 'superseded' ? 1 : item._lowConfidence ? 0.45 : 0;
  const charCost = Math.max(1, text.length + 16);
  const utility =
    relevance * 0.38 +
    necessity * 0.28 +
    confidence * 0.18 +
    freshness * 0.12 -
    contradictionRisk * 0.3 +
    0.04;
  return {
    item,
    index,
    text,
    dedupKey: normalizeText(text),
    mandatory: Boolean(item.fact_locked) && contradictionRisk < 1,
    relevance,
    necessity,
    confidence,
    freshness,
    contradictionRisk,
    charCost,
    utility,
    utilityPerChar: utility / charCost,
  };
}

function toDecision(candidate, reason) {
  return {
    index: candidate.index,
    id: candidate.item.id ?? null,
    source: candidate.item.source_kind ?? candidate.item.type ?? 'memory',
    reason,
    charCost: candidate.charCost,
    utility: round(candidate.utility),
    relevance: round(candidate.relevance),
    necessity: round(candidate.necessity),
    confidence: round(candidate.confidence),
    freshness: round(candidate.freshness),
    contradictionRisk: round(candidate.contradictionRisk),
  };
}

function evidenceText(item) {
  return String(
    item.narrative ?? item.fact_core ?? item.content ?? item.object_text ?? '',
  ).trim();
}

function freshnessScore(value, now) {
  const timestamp = new Date(value ?? 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0.4;
  const ageDays = Math.max(0, now - timestamp) / 86_400_000;
  return Math.exp(-ageDays / 90);
}

function normalizeText(value) {
  return String(value).toLowerCase().replace(/\s+/g, '').replace(/[，。！？、,.!?]/g, '');
}

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function positiveInt(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
