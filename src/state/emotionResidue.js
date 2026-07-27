/**
 * E1 · 情绪残留 + 标签惯性
 * 负面情绪不能一句玩笑就翻盘；道歉/修复语境可解粘。
 * 纯逻辑，无 IO。
 */

import { EMOTION_LABELS } from './emotionLabel.js';
import { PARAMS } from '../params.js';

export const NEGATIVE_EMOTION_LABELS = new Set(['委屈', '吃醋', '生气', '失落']);
export const POSITIVE_EMOTION_LABELS = new Set(['开心', '撒娇', '心疼']); // 心疼偏关怀，允许较快切换

const DEFAULT_STICKY = {
  生气: { minTurns: 2, baseIntensity: 0.75, halfTurns: 4 },
  委屈: { minTurns: 2, baseIntensity: 0.65, halfTurns: 3 },
  吃醋: { minTurns: 1, baseIntensity: 0.55, halfTurns: 3 },
  失落: { minTurns: 1, baseIntensity: 0.5, halfTurns: 3 },
  撒娇: { minTurns: 0, baseIntensity: 0.4, halfTurns: 2 },
  心疼: { minTurns: 0, baseIntensity: 0.45, halfTurns: 2 },
  开心: { minTurns: 0, baseIntensity: 0.35, halfTurns: 2 },
  平静: { minTurns: 0, baseIntensity: 0.2, halfTurns: 1 },
};

export function emptyEmotionResidue(now = Date.now()) {
  return {
    label: '平静',
    intensity: 0,
    cause: '',
    turnsHeld: 0,
    stickyTurnsLeft: 0,
    updatedAt: now,
  };
}

export function normalizeEmotionResidue(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return emptyEmotionResidue(now);
  const label = EMOTION_LABELS.includes(raw.label) ? raw.label : '平静';
  return {
    label,
    intensity: clamp01(raw.intensity),
    cause: String(raw.cause || '').slice(0, 80),
    turnsHeld: Math.max(0, Math.floor(Number(raw.turnsHeld) || 0)),
    stickyTurnsLeft: Math.max(0, Math.floor(Number(raw.stickyTurnsLeft) || 0)),
    updatedAt: Number(raw.updatedAt) || now,
  };
}

export function serializeEmotionResidue(residue) {
  return normalizeEmotionResidue(residue);
}

/**
 * 是否有强翻盘信号（允许离开负面粘性）
 */
export function hasEmotionFlipSignal(ctx = {}) {
  const userText = String(ctx.userMessage || ctx.userText || '');
  const relationship = ctx.relationship || {};
  const tension = Number(relationship.tension) || 0;
  const repairDebt = Number(relationship.repair_debt) || 0;
  const valence = Number(ctx.valence ?? ctx.emotion?.valence) || 0;

  // 明确道歉 / 求和
  if (/(对不起|抱歉|我错了|原谅我|别生气|和好|我爱你)/u.test(userText)) return true;
  // 认真安抚（够长 + 安抚词），不是随口哈哈
  if (
    userText.length >= 12 &&
    /(理解你|心疼|抱抱|想你|都是我不好|别闷|我在这|陪着你)/u.test(userText) &&
    tension < 0.5
  ) {
    return true;
  }
  // 关系债与紧张都已很低，且心情明显回正，才允许静默翻盘（避免一句闲聊解粘）
  if (repairDebt <= 0.05 && tension <= 0.08 && valence >= 0.35 && userText.length >= 8) return true;
  return false;
}

/**
 * 原始候选标签 + 残留 → 带惯性的最终标签与新残留
 * @param prev 上一轮 residual
 * @param candidateLabel 本轮规则推断
 * @param ctx {{ userMessage, relationship, valence, emotion, now, recoverBias? }}
 */
export function applyLabelInertia(prev = null, candidateLabel = '平静', ctx = {}) {
  const now = ctx.now ?? Date.now();
  const recoverRaw = Number(ctx.recoverBias);
  const recoverBias = Math.max(0.4, Math.min(2, Number.isFinite(recoverRaw) ? recoverRaw : 1));
  const cfg = PARAMS.emotion?.residue ?? {};
  const maxSticky = Math.max(1, Math.floor(Number(cfg.maxStickyTurns) || 8));

  let residual = normalizeEmotionResidue(prev, now);
  const candidate = EMOTION_LABELS.includes(candidateLabel) ? candidateLabel : '平静';
  const flip = hasEmotionFlipSignal(ctx);

  // 时间衰减 intensity（按小时）
  const hours = Math.max(0, (now - residual.updatedAt) / 3600000);
  if (hours > 0 && residual.intensity > 0) {
    const hl = Number(cfg.intensityHalfLifeHours) || 3;
    residual.intensity *= Math.pow(0.5, hours / hl);
    if (residual.intensity < 0.08) residual.intensity = 0;
  }

  // sticky 轮次自然减 1（本轮消耗）
  if (residual.stickyTurnsLeft > 0) residual.stickyTurnsLeft = Math.max(0, residual.stickyTurnsLeft - 1);

  let label = candidate;
  const prevNegative = NEGATIVE_EMOTION_LABELS.has(residual.label);
  const candPositive = !NEGATIVE_EMOTION_LABELS.has(candidate) && candidate !== residual.label;
  const stickyHold =
    prevNegative &&
    residual.intensity >= (cfg.minHoldIntensity ?? 0.22) &&
    (residual.stickyTurnsLeft > 0 || residual.turnsHeld < (DEFAULT_STICKY[residual.label]?.minTurns ?? 1));

  if (stickyHold && candPositive && !flip) {
    // 粘住旧负面；允许升级到更强负面
    if (NEGATIVE_EMOTION_LABELS.has(candidate) && rankNegative(candidate) > rankNegative(residual.label)) {
      label = candidate;
    } else {
      label = residual.label;
    }
  } else if (prevNegative && candPositive && flip) {
    label = candidate;
    residual.intensity *= 0.35;
    residual.stickyTurnsLeft = 0;
  } else {
    label = candidate;
  }

  // 更新 residual 字段
  if (label === residual.label) {
    residual.turnsHeld += 1;
    if (NEGATIVE_EMOTION_LABELS.has(label)) {
      residual.intensity = Math.min(1, residual.intensity + 0.05);
    } else {
      residual.intensity = Math.max(residual.intensity * 0.85, DEFAULT_STICKY[label]?.baseIntensity ?? 0.2);
    }
  } else {
    residual.turnsHeld = 1;
    const pack = DEFAULT_STICKY[label] || DEFAULT_STICKY.平静;
    residual.intensity = pack.baseIntensity;
    const sticky = Math.round((pack.minTurns + pack.halfTurns * 0.5) / recoverBias);
    residual.stickyTurnsLeft = Math.min(maxSticky, Math.max(0, sticky));
    residual.cause = String(ctx.userMessage || residual.cause || '').slice(0, 80);
  }

  residual.label = label;
  residual.updatedAt = now;
  residual = normalizeEmotionResidue(residual, now);
  return { label, residual };
}

/**
 * L5 · 故事 beat 软种子残留（不覆盖更强负面）
 * @returns {{ residual, changed: boolean, event? }}
 */
export function seedResidueFromStoryBeat(prev = null, beat = {}, now = Date.now()) {
  const cfg = PARAMS.emotion?.storySeed ?? {};
  if (cfg.enabled === false) return { residual: normalizeEmotionResidue(prev, now), changed: false };
  const moodLink = Number(beat?.mood_link ?? beat?.moodLink);
  if (!Number.isFinite(moodLink)) return { residual: normalizeEmotionResidue(prev, now), changed: false };

  let residual = normalizeEmotionResidue(prev, now);
  const seedI = Number(cfg.seedIntensity) ?? 0.42;
  const negTh = Number(cfg.negativeMoodLink) ?? -0.3;
  const posTh = Number(cfg.positiveMoodLink) ?? 0.4;
  const cause = String(beat?.content || beat?.title || '').slice(0, 80);

  if (moodLink <= negTh) {
    // 不强行盖过 生气 / 高强度委屈
    if (residual.label === '生气' && residual.intensity >= 0.5) {
      return { residual, changed: false };
    }
    if (residual.label === '委屈' && residual.intensity >= 0.65) {
      return { residual, changed: false };
    }
    residual = {
      ...residual,
      label: '失落',
      intensity: Math.max(residual.intensity, seedI * Math.min(1, Math.abs(moodLink))),
      cause: cause || residual.cause,
      turnsHeld: residual.label === '失落' ? residual.turnsHeld + 1 : 1,
      stickyTurnsLeft: Math.max(residual.stickyTurnsLeft, 2),
      updatedAt: now,
    };
    return {
      residual: normalizeEmotionResidue(residual, now),
      changed: true,
      event: { fromLabel: prev?.label || '', toLabel: '失落', intensity: residual.intensity, cause, source: 'story', at: now },
    };
  }

  if (moodLink >= posTh) {
    if (NEGATIVE_EMOTION_LABELS.has(residual.label) && residual.intensity >= 0.35) {
      return { residual, changed: false };
    }
    residual = {
      ...residual,
      label: '开心',
      intensity: Math.max(0.3, seedI * Math.min(1, moodLink)),
      cause: cause || residual.cause,
      turnsHeld: residual.label === '开心' ? residual.turnsHeld + 1 : 1,
      stickyTurnsLeft: 1,
      updatedAt: now,
    };
    return {
      residual: normalizeEmotionResidue(residual, now),
      changed: true,
      event: { fromLabel: prev?.label || '', toLabel: '开心', intensity: residual.intensity, cause, source: 'story', at: now },
    };
  }

  return { residual, changed: false };
}

function rankNegative(label) {
  if (label === '生气') return 4;
  if (label === '委屈') return 3;
  if (label === '失落') return 2;
  if (label === '吃醋') return 2;
  return 0;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
