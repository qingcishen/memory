import assert from 'node:assert';
import {
  planTurn,
  applyBehaviorSampling,
  enforcePartsBudget,
  stripStockEndingsFromParts,
  buildTurnBrief,
} from '../src/orchestrator/turnPlan.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('planTurn');
{
  const intimate = planTurn({
    userMessage: '抱紧我',
    sceneLocks: [{ id: 'intimate' }],
    behavior: { lengthHint: 'chatty', partsBudget: 3 },
    goals: [{ kind: 'intimacy', text: '靠近', priority: 0.8 }],
    intimacyPhase: 'foreplay',
    historyTurnsDefault: 6,
    useMonologueDefault: true,
  });
  ok('亲密场景加深历史', intimate.historyTurns >= 7);
  ok('有本轮简报', intimate.turnBrief.includes('本轮简报') && intimate.turnBrief.includes('intimate'));
  ok('召回 query 非空', intimate.recallQuery.length > 0);

  const terseHi = planTurn({
    userMessage: '在吗',
    sceneLocks: [],
    behavior: { lengthHint: 'terse', partsBudget: 1 },
    goals: [],
    historyTurnsDefault: 6,
    useMonologueDefault: true,
  });
  ok('寒暄跳过独白', terseHi.useMonologue === false);
  ok('terse 历史略减或不增太多', terseHi.historyTurns <= 6);

  const conflict = planTurn({
    userMessage: '你怎么这样',
    sceneLocks: [{ id: 'conflict' }],
    behavior: { lengthHint: 'terse', partsBudget: 1, recoveryPath: '留缝' },
    goals: [{ kind: 'desire', text: '确认', priority: 0.5 }],
    historyTurnsDefault: 6,
  });
  ok('冲突简报含可恢复或 terse', /可恢复|terse|conflict/.test(conflict.turnBrief));
}

console.log('sampling + parts');
{
  const s = applyBehaviorSampling({ maxTokens: 500, temperature: 0.8 }, { lengthHint: 'terse' }, {});
  ok('terse 压 token', s.maxTokens <= 280 && s.maxTokens < 500);
  const chatty = applyBehaviorSampling({ maxTokens: 400, temperature: 0.8 }, { lengthHint: 'chatty' }, {});
  ok('chatty 不硬抬 token（保留 life 基线）', chatty.maxTokens === 400);

  const parts = [
    { type: 'narration', text: '她靠过来' },
    { type: 'dialogue', text: '一' },
    { type: 'dialogue', text: '二' },
    { type: 'dialogue', text: '三' },
  ];
  const capped = enforcePartsBudget(parts, 2);
  ok('parts 预算保留旁白', capped.some((p) => p.type === 'narration'));
  ok('dialogue 最多 2', capped.filter((p) => p.type === 'dialogue').length === 2);

  const stock = stripStockEndingsFromParts(
    [{ type: 'dialogue', text: '好舒服，明天上课困了别怪我' }],
    [{ id: 'intimate' }],
  );
  ok('库存结尾被抠', !stock[0].text.includes('明天上课') && stock[0].text.includes('好舒服'));
}

console.log('buildTurnBrief');
{
  const b = buildTurnBrief({ lockIds: ['car'], phase: 'peak', lengthHint: 'normal', topGoal: '接住' });
  ok('简报含场景与意图', b.includes('car') && b.includes('接住'));
}

console.log(`\nturn-plan 全部 ${passed} 条断言通过 ✅`);
