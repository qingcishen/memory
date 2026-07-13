/**
 * L1 · 情绪残留 → 需求耦合（纯逻辑）
 * 委屈/失落抬 comfort/security；生气抬 security/attention。
 */

import { PARAMS } from '../params.js';
import { NEGATIVE_EMOTION_LABELS } from './emotionResidue.js';

/**
 * @param residual {{ label, intensity }}
 * @returns {{ attention?: number, sharing?: number, comfort?: number, security?: number, reason?: string } | null}
 */
export function residueToDesireEvent(residual = null, config = PARAMS.emotion?.desireBridge) {
  if (config?.enabled === false) return null;
  if (!residual?.label) return null;
  const intensity = Math.min(1, Math.max(0, Number(residual.intensity) || 0));
  const minI = Number(config?.minIntensity) ?? 0.4;
  if (intensity < minI) return null;
  if (!NEGATIVE_EMOTION_LABELS.has(residual.label) && residual.label !== '吃醋') return null;

  const scale = (Number(config?.scale) ?? 0.2) * intensity;
  const event = {};
  const label = residual.label;

  if (label === '委屈' || label === '失落') {
    event.comfort = scale * (Number(config?.comfortFactor) ?? 1);
    event.security = scale * (Number(config?.securityFactor) ?? 0.7);
    event.reason = label === '委屈' ? '委屈余味想被轻轻接住' : '失落时想被安抚';
  } else if (label === '生气') {
    event.security = scale * (Number(config?.angrySecurityFactor) ?? 0.9);
    event.attention = scale * (Number(config?.angryAttentionFactor) ?? 0.5);
    event.reason = '还在气头上，想被认真对待';
  } else if (label === '吃醋') {
    event.security = scale * (Number(config?.jealousSecurityFactor) ?? 0.6);
    event.reason = '醋意里想被确认唯一';
  } else {
    return null;
  }

  // 去掉过小增量
  for (const k of Object.keys(event)) {
    if (k === 'reason') continue;
    if (Math.abs(event[k]) < 0.02) delete event[k];
  }
  if (!Object.keys(event).some((k) => k !== 'reason')) return null;
  return event;
}
