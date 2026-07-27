/**
 * 召回可解释：把 hits 上的分数/标签翻译成「为何想起这条」
 * 纯逻辑，供 debug / 调试 UI。
 */

import { inferPreferenceTier } from '../product/preferenceTier.js';

/**
 * @param hits memory hits from recall (with similarity, _score, activation, etc.)
 * @param query recall query string
 * @returns {array} slim explain rows
 */
export function explainRecallHits(hits = [], query = '') {
  return (hits || []).slice(0, 12).map((h, index) => {
    const reasons = [];
    const sim = num(h.similarity ?? h._similarity);
    const score = num(h._score ?? h.score);
    const act = num(h.activation);
    const imp = num(h.importance, null);
    const tier = h.preference_tier || inferPreferenceTier(h);

    if (sim != null) {
      if (sim >= 0.85) reasons.push('与当前话高度语义相近');
      else if (sim >= 0.7) reasons.push('与当前话相关');
      else if (sim >= 0.55) reasons.push('弱相关，作背景');
      else reasons.push('相关度一般');
    }
    if (act != null && act > 0) {
      if (act >= 0.7) reasons.push('激活高（常被想起/很新）');
      else if (act >= 0.4) reasons.push('中等激活');
    }
    if (imp != null && imp >= 7) reasons.push(`重要性高(${imp})`);
    if (h.subject_kind === 'dyad') reasons.push('共同记忆底色');
    if (h.fact_locked || tier === 'locked') reasons.push('硬边界/锁定事实');
    if (tier === 'soft') reasons.push('稳定偏好');
    if (tier === 'whim') reasons.push('一时兴起（别当铁律）');
    if (h._lowConfidence) reasons.push('低置信→措辞会带「好像」');
    if (h.type === 'episode') reasons.push('篇章/情节记忆');
    if (h.type === 'preference') reasons.push('偏好类');
    if (!reasons.length) reasons.push('检索命中');

    const snippet = String(h.narrative || h.fact_core || h.content || '').slice(0, 80);
    return {
      rank: index + 1,
      id: h.id ?? null,
      type: h.type ?? null,
      subject_kind: h.subject_kind ?? null,
      preference_tier: tier !== 'none' ? tier : null,
      similarity: sim,
      score,
      activation: act,
      importance: imp,
      lowConfidence: Boolean(h._lowConfidence),
      why: reasons.join('；'),
      snippet,
      query: query ? String(query).slice(0, 80) : undefined,
    };
  });
}

/** 给人读的一小段，可塞进 debug 文本 */
export function formatRecallExplanation(explanations = [], query = '') {
  if (!explanations.length) return '';
  const head = query ? `召回 query「${String(query).slice(0, 40)}」命中 ${explanations.length} 条：\n` : `召回命中 ${explanations.length} 条：\n`;
  const lines = explanations.map((e) => `${e.rank}. [${e.type || '?'}] ${e.why} — ${e.snippet}`);
  return head + lines.join('\n');
}

function num(v, d = null) {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isNaN(n) ? d : Math.round(n * 1000) / 1000;
}
