/**
 * E4 · 触景生情：高情绪记忆被召回时，给本轮展示层一点微扰（默认不写库）。
 * 纯逻辑。
 */

import { PARAMS } from '../params.js';

/**
 * @param hits recall hits（可含 affect_valence / affect_intensity / emotion）
 * @param currentEmotion { valence, warmth }
 * @returns {{ valenceDelta: number, warmthDelta: number, reasons: string[] } | null}
 */
export function resonateFromMemoryHits(hits = [], currentEmotion = {}) {
  const cfg = PARAMS.emotion?.resonate ?? {};
  if (cfg.enabled === false) return null;
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return null;

  const minIntensity = Number(cfg.minIntensity) ?? 0.45;
  const maxAbs = Number(cfg.maxAbsDelta) ?? 0.12;
  const valence = Number(currentEmotion.valence) || 0;

  let sum = 0;
  let weight = 0;
  const reasons = [];

  for (const h of list.slice(0, 8)) {
    const intensity = Number(h.affect_intensity ?? h.emotion ?? h.intensity) || 0;
    if (intensity < minIntensity) continue;
    let av = Number(h.affect_valence);
    if (!Number.isFinite(av)) {
      // 无 valence 时用 intensity 符号猜：叙事负面词
      const blob = String(h.fact_core || h.content || h.narrative || '');
      av = /(吵|哭|伤|恨|分手|冷|骂)/.test(blob) ? -intensity : intensity * 0.3;
    }
    const w = intensity;
    sum += av * w;
    weight += w;
    if (reasons.length < 3) {
      reasons.push(String(h.fact_core || h.content || '').slice(0, 40));
    }
  }

  if (weight <= 0) return null;
  const mean = sum / weight;
  // 与当前心情反差越大，触景越明显
  const contrast = mean - valence;
  let valenceDelta = contrast * (Number(cfg.contrastGain) ?? 0.25);
  valenceDelta = Math.max(-maxAbs, Math.min(maxAbs, valenceDelta));
  if (Math.abs(valenceDelta) < 0.02) return null;

  const warmthDelta = valenceDelta * (Number(cfg.warmthCoupling) ?? 0.15);
  return {
    valenceDelta,
    warmthDelta: Math.max(-maxAbs * 0.5, Math.min(maxAbs * 0.5, warmthDelta)),
    reasons,
  };
}

/** 把微扰应用到展示用 emotion（不改持久化 state） */
export function applyResonanceToEmotion(emotion = {}, resonance = null) {
  if (!resonance) return emotion;
  const v = clamp((Number(emotion.valence) || 0) + (resonance.valenceDelta || 0), -1, 1);
  const w = clamp((Number(emotion.warmth) || 0.5) + (resonance.warmthDelta || 0), 0, 1);
  return { ...emotion, valence: v, warmth: w };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
