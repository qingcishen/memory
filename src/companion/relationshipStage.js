/**
 * 关系阶段 · 行为剧本
 * 把 closeness/trust/tension/repair_debt 映射成可观察的阶段与 prompt 指引。
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

export function relationshipStageToPrompt(stage, relationship = {}) {
  if (!stage?.id) return '';
  const scripts = {
    strangers: '【关系阶段·初识】礼貌、观察、别一口一个亲昵过头；可以好奇，但别假装已经很熟。',
    warming: '【关系阶段·靠近中】语气变热、偶尔试探边界；可以撩一点，别默认已经同居默契满分。',
    close: '【关系阶段·亲密恋人】日常黏、可以半命令式、知道彼此习惯；仍要像聊天不是念设定。',
    bonded: '【关系阶段·深度绑定】默契、省略解释、可以用你们的梗；冲突时也更在乎「我们」而不是输赢。',
    tense: '【关系阶段·紧绷】话短、防御、别突然撒娇求欢；可以冷，但留一点缝，别永久性判死刑。',
    repair: '【关系阶段·修复中】优先台阶与确认，语气软一点；别假装没事狂亲，也别翻旧账清单。',
  };
  const base = scripts[stage.id] || '';
  const extra = [];
  if (num01(relationship.tension) >= 0.4) extra.push('张力偏高：先接情绪再谈事。');
  if (num01(relationship.repair_debt) >= 0.25) extra.push('还有未消的和好债：给对方台阶比证明自己对更重要。');
  return [base, ...extra].filter(Boolean).join('\n');
}

function num01(v, d = 0) {
  const n = Number(v);
  if (Number.isNaN(n)) return d;
  return Math.min(1, Math.max(0, n));
}
