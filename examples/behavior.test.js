import assert from 'node:assert';
import { behaviorPolicy, behaviorToPrompt } from '../src/state/behavior.js';
import { EMOTION_LABELS } from '../src/state/emotionLabel.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); console.log('  ✓', name); passed++; }
const conflict = { relationship: { tension: 0.9, repair_debt: 0.8 } };

console.log('behaviorPolicy B2 策略边界');
for (const label of EMOTION_LABELS) {
  const p = behaviorPolicy(label, conflict);
  ok(`${label} 策略结构合法`, p.replyDelayMs[0] >= 0 && p.replyDelayMs[1] <= PARAMS.behavior.maxReplyDelayMs && p.replyDelayMs[0] <= p.replyDelayMs[1] && p.partsBudget >= 1);
}
const calm = behaviorPolicy('平静', conflict);
const angry = behaviorPolicy('生气', conflict);
ok('生气时延迟增加', angry.replyDelayMs[0] > calm.replyDelayMs[0]);
ok('生气时允许两条短气泡 / terse', angry.partsBudget === 2 && angry.lengthHint === 'terse');
ok('所有延迟不超过十分钟硬上限', EMOTION_LABELS.every((label) => behaviorPolicy(label, conflict).replyDelayMs[1] <= 10 * 60 * 1000));
ok('极高冲突且未用额度可 stonewall', angry.stonewall === true);
ok('stonewall 每日额度用完立即关闭', behaviorPolicy('生气', { ...conflict, stonewallUsedToday: 1 }).stonewall === false);
ok('stonewall 后下一轮必须给台阶', behaviorPolicy('生气', { ...conflict, mustGiveRepairStep: true }).stonewall === false);
const repaired = behaviorPolicy('生气', { relationship: { tension: 0, repair_debt: 0 } });
ok('repair_debt 清零后负面延迟立即失效', repaired.replyDelayMs[1] <= PARAMS.behavior.repairedMaxDelayMs && !repaired.stonewall);
ok('话量提示不暴露策略数值', behaviorToPrompt(angry).includes('话少一点') && !behaviorToPrompt(angry).includes('partsBudget'));
console.log(`\nBehavior 全部 ${passed} 条断言通过`);
