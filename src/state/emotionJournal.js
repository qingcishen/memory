/**
 * L3 · 情绪事件账本（纯逻辑）
 * 只记标签切换 / 强度跳变，供 prompt 余波与 debug。
 */

import { sanitizeForPrompt } from '../promptSafety.js';

const MAX_EVENTS = 20;

/**
 * @returns {{ at, fromLabel, toLabel, intensity, cause, source }[]}
 */
export function emptyEmotionJournal() {
  return [];
}

export function normalizeEmotionJournal(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && e.toLabel)
    .map((e) => ({
      at: Number(e.at) || Date.now(),
      fromLabel: String(e.fromLabel || ''),
      toLabel: String(e.toLabel || ''),
      intensity: Math.min(1, Math.max(0, Number(e.intensity) || 0)),
      cause: String(e.cause || '').slice(0, 80),
      source: e.source || 'turn',
    }))
    .slice(-MAX_EVENTS);
}

/**
 * 是否值得记一条
 */
export function shouldLogEmotionTransition(prevLabel, nextLabel, prevIntensity, nextIntensity) {
  if (nextLabel && nextLabel !== prevLabel) return true;
  if (Math.abs((nextIntensity || 0) - (prevIntensity || 0)) >= 0.25) return true;
  return false;
}

export function appendEmotionEvent(journal = [], event = {}, { max = MAX_EVENTS } = {}) {
  const list = normalizeEmotionJournal(journal);
  if (!event?.toLabel) return list;
  const row = {
    at: event.at ?? Date.now(),
    fromLabel: String(event.fromLabel || ''),
    toLabel: String(event.toLabel),
    intensity: Math.min(1, Math.max(0, Number(event.intensity) || 0)),
    cause: String(event.cause || '').slice(0, 80),
    source: event.source || 'turn',
  };
  // 去抖：同一秒同 toLabel 不重复
  const last = list[list.length - 1];
  if (last && last.toLabel === row.toLabel && Math.abs(last.at - row.at) < 2000) {
    list[list.length - 1] = { ...last, ...row, intensity: Math.max(last.intensity, row.intensity) };
    return list.slice(-max);
  }
  return [...list, row].slice(-max);
}

/**
 * 注入 system 的短余波（禁止数值）
 */
export function emotionJournalToPrompt(journal = [], limit = 2) {
  const list = normalizeEmotionJournal(journal).slice(-limit);
  if (!list.length) return '';
  const bits = list.map((e) => {
    const cause = e.cause ? sanitizeForPrompt(e.cause).slice(0, 24) : '';
    if (e.fromLabel && e.fromLabel !== e.toLabel) {
      return cause ? `${e.fromLabel}→${e.toLabel}（因「${cause}」）` : `${e.fromLabel}→${e.toLabel}`;
    }
    return cause ? `仍偏${e.toLabel}（${cause}）` : `仍偏${e.toLabel}`;
  });
  return `【情绪余波】最近：${bits.join('；')}。接话时自然带连续性，不要复述本清单，不要播报情绪名称。`;
}
