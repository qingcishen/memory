/**
 * 关系阶段 · 行为剧本
 * 把 closeness/trust/tension/repair_debt 映射成可观察的阶段、prompt 指引、行为策略修正。
 */

export const RELATIONSHIP_STAGES = {
  strangers: { id: 'strangers', label: '初识', priority: 0 },
  warming: { id: 'warming', label: '靠近中', priority: 1 },
  close: { id: 'close', label: '亲密恋人', priority: 2 },
  bonded: { id: 'bonded', label: '深度绑定', priority: 3 },
  tense: { id: 'tense', label: '紧绷/冷战边缘', priority: 4 },
  repair: { id: 'repair', label: '修复中', priority: 5 },
};

/**
 * @param relationship { closeness, trust, tension, repair_debt }
 */
export function inferRelationshipStage(relationship = {}) {
  const c = num01(relationship.closeness, 0.5);
  const t = num01(relationship.trust, 0.5);
  const tension = num01(relationship.tension, 0);
  const debt = num01(relationship.repair_debt, 0);

  if (debt >= 0.35 || (tension >= 0.55 && debt >= 0.15)) return RELATIONSHIP_STAGES.repair;
  if (tension >= 0.7) return RELATIONSHIP_STAGES.tense;
  if (c >= 0.75 && t >= 0.7) return RELATIONSHIP_STAGES.bonded;
  if (c >= 0.55 && t >= 0.5) return RELATIONSHIP_STAGES.close;
  if (c >= 0.35) return RELATIONSHIP_STAGES.warming;
  return RELATIONSHIP_STAGES.strangers;
}

/**
 * 阶段默认行为包：投递层 / behaviorPolicy 可叠加。
 * @returns {{ lengthHint?, partsBudgetDelta?, delayFactor?, proactiveBias?, intimacyGate?, recoveryPath }}
 */
export function relationshipStageBehavior(stage) {
  const id = stage?.id || stage;
  const packs = {
    strangers: {
      lengthHint: 'normal',
      partsBudgetDelta: 0,
      delayFactor: 1,
      proactiveBias: -0.15,
      intimacyGate: 'closed',
      recoveryPath: '保持礼貌好奇即可',
    },
    warming: {
      lengthHint: 'normal',
      partsBudgetDelta: 0,
      delayFactor: 0.9,
      proactiveBias: 0.05,
      intimacyGate: 'soft',
      recoveryPath: '试探后要给对方退路',
    },
    close: {
      lengthHint: 'chatty',
      partsBudgetDelta: 1,
      delayFactor: 0.7,
      proactiveBias: 0.1,
      intimacyGate: 'open',
      recoveryPath: '小摩擦先抱抱再讲理',
    },
    bonded: {
      lengthHint: 'chatty',
      partsBudgetDelta: 1,
      delayFactor: 0.6,
      proactiveBias: 0.15,
      intimacyGate: 'open',
      recoveryPath: '用「我们」说话，冲突也优先关系',
    },
    tense: {
      lengthHint: 'terse',
      partsBudgetDelta: -1,
      delayFactor: 2.5,
      proactiveBias: -0.45,
      intimacyGate: 'closed',
      recoveryPath: '冷可以，但留缝：一句「回头再说」比拉黑像人；对方台阶要接住',
    },
    repair: {
      lengthHint: 'normal',
      partsBudgetDelta: 0,
      delayFactor: 1.2,
      proactiveBias: -0.1,
      intimacyGate: 'soft',
      recoveryPath: '优先确认与台阶，别翻旧账清单，也别假装没事狂亲',
    },
  };
  return packs[id] || packs.close;
}

export function relationshipStageToPrompt(stage, relationship = {}) {
  if (!stage?.id) return '';
  const scripts = {
    strangers: '【关系阶段·初识】礼貌、观察、别一口一个亲昵过头；可以好奇，但别假装已经很熟。',
    warming: '【关系阶段·靠近中】语气变热、偶尔试探边界；可以撩一点，别默认已经同居默契满分。',
    close: '【关系阶段·亲密恋人】日常黏、可以半命令式、知道彼此习惯；仍要像聊天不是念设定。',
    bonded: '【关系阶段·深度绑定】默契、省略解释、可以用你们的梗；冲突时也更在乎「我们」而不是输赢。',
    tense: '【关系阶段·紧绷/冷战】话短、防御、别突然撒娇求欢；可以冷，但留一点缝（可恢复路径始终在场），别永久性判死刑。',
    repair: '【关系阶段·修复中】优先台阶与确认，语气软一点；别假装没事狂亲，也别翻旧账清单。',
  };
  const pack = relationshipStageBehavior(stage);
  const base = scripts[stage.id] || '';
  const extra = [];
  if (num01(relationship.tension) >= 0.4) extra.push('张力偏高：先接情绪再谈事。');
  if (num01(relationship.repair_debt) >= 0.25) extra.push('还有未消的和好债：给对方台阶比证明自己对更重要。');
  if (pack.recoveryPath) extra.push(`【可恢复】${pack.recoveryPath}`);
  if (pack.intimacyGate === 'closed') extra.push('本阶段不主动推高热亲密。');
  return [base, ...extra].filter(Boolean).join('\n');
}

/**
 * 把阶段行为包叠到现有 behaviorPolicy 结果上（纯函数）。
 */
export function applyStageToBehavior(policy = {}, stage) {
  const pack = relationshipStageBehavior(stage);
  if (!policy || !pack) return policy;
  const [d0, d1] = Array.isArray(policy.replyDelayMs) ? policy.replyDelayMs : [0, 0];
  const factor = pack.delayFactor ?? 1;
  let parts = Math.max(1, (policy.partsBudget ?? 2) + (pack.partsBudgetDelta ?? 0));
  let lengthHint = policy.lengthHint;
  // 阶段 terse 压过 chatty（冷战时不兴致高）
  if (pack.lengthHint === 'terse') lengthHint = 'terse';
  else if (pack.lengthHint === 'chatty' && lengthHint === 'normal') lengthHint = 'chatty';
  return {
    ...policy,
    replyDelayMs: [Math.round(d0 * factor), Math.round(d1 * factor)],
    partsBudget: parts,
    lengthHint,
    proactiveBias: clamp(Number(policy.proactiveBias || 0) + Number(pack.proactiveBias || 0), -1, 1),
    relationshipStage: stage?.id || stage,
    recoveryPath: pack.recoveryPath,
    intimacyGate: pack.intimacyGate,
  };
}

function num01(v, d = 0) {
  const n = Number(v);
  if (Number.isNaN(n)) return d;
  return Math.min(1, Math.max(0, n));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
