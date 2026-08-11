// E-2 · CEE 离散情绪权威层 + M1 数值底座兼容桥。

import { EMOTION_LABELS } from '../state/emotionLabel.js';

const LEGACY_LABEL_MAP = Object.freeze({
  neutral: '平静',
  calm: '平静',
  happy: '开心',
  joyful: '开心',
  excited: '期待',
  hopeful: '期待',
  sad: '失落',
  disappointed: '失落',
  hurt: '委屈',
  jealous: '吃醋',
  angry: '生气',
  worried: '担心',
  anxious: '担心',
  concerned: '担心',
  surprised_pleasant: '期待',
  touched: '感动',
  bored: '无聊',
  frustrated: '烦躁',
  irritated: '烦躁',
  proud: '骄傲',
  shy: '害羞',
  intimate: '暧昧',
});

export function normalizeCeeEmotionLabel(value, fallback = null) {
  const label = String(value ?? '').trim();
  if (EMOTION_LABELS.includes(label)) return label;
  return LEGACY_LABEL_MAP[label.toLowerCase()] ?? fallback;
}

/**
 * CEE 有仍在持续的标签时，它是离散情绪真相；否则才用本轮 M1 规则结果冷启动。
 */
export function selectAuthoritativeEmotionLabel(
  emotional = null,
  fallback = '平静',
) {
  const source = emotional && typeof emotional === 'object' ? emotional : {};
  const persisted = normalizeCeeEmotionLabel(source.label);
  if (persisted && Number(source.persistence) > 0) return persisted;
  const runtime = normalizeCeeEmotionLabel(source.current_emotion);
  if (
    runtime &&
    runtime !== '平静' &&
    Number(source.emotion_intensity) > 0
  ) {
    return runtime;
  }
  return normalizeCeeEmotionLabel(fallback, '平静');
}

/**
 * 把本轮权威标签写进 CEE，同时只从 M1 读取 valence 数值底座。
 * 不在这里再次运行离散分类，避免 M1/CEE 两套标签相互打架。
 */
export function synchronizeCeeEmotion(
  emotional = null,
  {
    label = null,
    emotion = null,
    intensity = null,
    minPersistence = 1.5,
  } = {},
) {
  const current =
    emotional && typeof emotional === 'object' ? { ...emotional } : {};
  const resolvedLabel = normalizeCeeEmotionLabel(
    label,
    selectAuthoritativeEmotionLabel(current, '平静'),
  );
  const numericValence = Number(emotion?.valence);
  const numericIntensity = Number(intensity);
  const neutralAtRest =
    resolvedLabel === '平静' &&
    !Number.isFinite(numericIntensity) &&
    (Number(current.emotion_intensity) || 0) <= 0 &&
    (!Number.isFinite(numericValence) || numericValence === 0);
  const derivedIntensity = Number.isFinite(numericIntensity)
    ? numericIntensity
    : neutralAtRest
      ? 0
    : Math.max(
        Number(current.emotion_intensity) || 0,
        Math.min(1, 0.25 + Math.abs(Number.isFinite(numericValence) ? numericValence : 0) * 0.75),
      );
  return {
    ...current,
    current_emotion: resolvedLabel,
    label: resolvedLabel,
    emotion_intensity: clamp(derivedIntensity, 0, 1),
    valence: Number.isFinite(numericValence)
      ? clamp(numericValence, -1, 1)
      : clamp(Number(current.valence) || 0, -1, 1),
    persistence: Math.max(
      Number(current.persistence) || 0,
      Number(minPersistence) || 0,
    ),
  };
}

export function sameEmotionDirection(emotional = null, emotion = null) {
  const cee = Number(emotional?.valence);
  const m1 = Number(emotion?.valence);
  if (!Number.isFinite(cee) || !Number.isFinite(m1)) return null;
  return Math.sign(cee) === Math.sign(m1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
