import assert from 'node:assert';
import { DesireDimension, accumulateDesires, clampDesires, defaultDesires, evolveDesiresOverTime, settleDesiresFromTurns, toDesirePrompt } from '../src/state/desire.js';
let passed = 0;
function ok(name, condition) { assert.ok(condition, name); console.log('  ✓', name); passed++; }

console.log('desire pure logic');
ok('默认四项需求为 0', Object.values(defaultDesires()).every((v) => v === 0));
ok('所有驱力钳制在 0..1', clampDesires({ attention: 3, sharing: -1 }).attention === 1 && clampDesires({ attention: 3, sharing: -1 }).sharing === 0);
const afterThreeDays = evolveDesiresOverTime(defaultDesires(), 72);
ok('三天沉默后 attention >= 0.8', afterThreeDays.attention >= 0.8);
ok('没有事件时其余需求不凭空增长', afterThreeDays.sharing === 0 && afterThreeDays.comfort === 0 && afterThreeDays.security === 0);
ok('事件累积受上限钳制', accumulateDesires({ sharing: 0.8 }, { sharing: 0.5 }).sharing === 1);
const relieved = settleDesiresFromTurns(afterThreeDays, [{ role: 'user', content: '这几天确实很忙，但我现在认真陪你聊聊今天发生的事。' }]);
ok('认真聊一轮后 attention 明显回落', relieved.attention <= afterThreeDays.attention - 0.5);
const dismissed = settleDesiresFromTurns({ attention: 0.4, security: 0.2 }, [{ role: 'user', content: '嗯嗯' }]);
ok('敷衍回应加剧 attention/security', dismissed.attention > 0.4 && dismissed.security > 0.2);
ok('低于阈值时不注入需求 prompt', toDesirePrompt({ attention: 0.4 }) === '');
const needPrompt = toDesirePrompt({ attention: 0.8, comfort: 0.7 });
ok('高需求转成表现指引且不暴露数值', needPrompt.includes('求关注') && needPrompt.includes('安慰') && !needPrompt.includes('0.8'));

console.log('DesireDimension lazy evolution/persistence');
{
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const now = start + 72 * 60 * 60 * 1000;
  let row = { ...defaultDesires(), updated_at: new Date(start).toISOString() };
  const dim = new DesireDimension({ userId: 'u_desire', now: () => now, read: async () => row,
    write: async (_u, _c, desires, writtenAt) => { row = { ...desires, updated_at: new Date(writtenAt).toISOString() }; return row; } });
  ok('snapshot 惰性计算三天沉默', (await dim.snapshot()).attention >= 0.8);
  await dim.evolve([{ role: 'user', content: '我来了，今天想好好听你说说发生了什么。' }]);
  ok('evolve 消解并写回新时间锚点', row.attention < 0.5 && row.updated_at === new Date(now).toISOString());
  await dim.accumulate({ comfort: 0.4 });
  ok('accumulate 注入外部事件', row.comfort === 0.4);
}
console.log(`\nDesire 全部 ${passed} 条断言通过`);
