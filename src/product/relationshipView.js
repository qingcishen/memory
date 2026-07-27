/**
 * P2 · 关系页视图：阶段 + 里程碑 + 可观察状态（给终端用户，不是仪表盘原始数）
 */

import { inferRelationshipStage, relationshipStageToPrompt, relationshipStageBehavior } from '../companion/relationshipStage.js';

/**
 * @param {{
 *   relationship?: object,
 *   annuals?: array,
 *   episodes?: array,
 *   behavior?: object,
 *   desires?: object,
 * }} input
 */
export function buildRelationshipView(input = {}) {
  const rel = input.relationship || {};
  const stage = inferRelationshipStage(rel);
  const pack = relationshipStageBehavior(stage);
  const milestones = [];

  for (const a of input.annuals || []) {
    milestones.push({
      kind: 'annual',
      title: a.content || '纪念日',
      at: a.trigger_at || a.created_at,
      status: a.status,
    });
  }

  // 从篇章里抽里程碑味道的条目
  for (const ep of input.episodes || []) {
    const text = String(ep.narrative || ep.content || ep.fact_core || '');
    if (/第一次|纪念日|和好|吵架|杭州|出差/.test(text)) {
      milestones.push({
        kind: 'episode',
        title: text.slice(0, 80),
        at: ep.created_at,
        status: 'remembered',
      });
    }
  }

  milestones.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  return {
    stage: {
      id: stage.id,
      label: stage.label,
      script: relationshipStageToPrompt(stage, rel),
      behavior: {
        lengthHint: pack.lengthHint,
        intimacyGate: pack.intimacyGate,
        recoveryPath: pack.recoveryPath,
      },
    },
    // 用户可读，不强调原始 0~1
    feel: {
      closeness: feelBand(rel.closeness, ['还在熟悉', '渐渐亲近', '很亲密', '深度绑定']),
      trust: feelBand(rel.trust, ['还在试探', '开始信任', '相当信任', '深信不疑']),
      tension: Number(rel.tension) >= 0.55 ? '有点紧绷' : Number(rel.tension) >= 0.3 ? '略有别扭' : '平静',
      repair: Number(rel.repair_debt) >= 0.25 ? '还有未消的和好债' : '没有明显和好债',
    },
    raw: {
      closeness: num01(rel.closeness),
      trust: num01(rel.trust),
      tension: num01(rel.tension),
      repair_debt: num01(rel.repair_debt),
    },
    milestones: milestones.slice(0, 12),
    desires: input.desires || null,
    behavior: input.behavior || null,
  };
}

function feelBand(value, labels = []) {
  const v = num01(value);
  if (v < 0.35) return labels[0];
  if (v < 0.55) return labels[1];
  if (v < 0.75) return labels[2];
  return labels[3] || labels[2];
}

function num01(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
