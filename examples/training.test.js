// M9 纯逻辑测试: 每日训练 (知识滴灌挑选 + 自我日记 prompt 拼接)。不连网。
import assert from 'node:assert';
import { pickDailyKnowledge, buildDiaryPrompt } from '../src/training.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('pickDailyKnowledge (按知识库顺序挑选未灌过的, 去重稳定)');
{
  const bank = ['事实A', '事实B', { fact_core: '事实C', importance: 6 }];

  const first = pickDailyKnowledge(bank, new Set(), 1);
  ok('空已灌集合 -> 按顺序取第一条', first.length === 1 && first[0].fact_core === '事实A');

  const skipped = pickDailyKnowledge(bank, new Set(['事实A']), 1);
  ok('已灌过的会跳过, 取下一条', skipped.length === 1 && skipped[0].fact_core === '事实B');

  const limited = pickDailyKnowledge(bank, new Set(), 2);
  ok('limit 控制取条数', limited.length === 2 && limited[1].fact_core === '事实B');

  const obj = pickDailyKnowledge(bank, new Set(['事实A', '事实B']), 1);
  ok('对象形态原样保留其它字段 (importance)', obj[0].fact_core === '事实C' && obj[0].importance === 6);

  const exhausted = pickDailyKnowledge(bank, new Set(['事实A', '事实B', '事实C']), 1);
  ok('全部灌完后返回空数组', exhausted.length === 0);

  ok('空知识库 -> 空数组', pickDailyKnowledge([], new Set(), 1).length === 0);
}

console.log('buildDiaryPrompt (自我日记 LLM 输入拼接)');
{
  const ctx = buildDiaryPrompt({ personaPrompt: 'A', statePrompt: 'B', relationshipPrompt: 'C' });
  ok('包含各子系统段落', ctx.includes('A') && ctx.includes('B') && ctx.includes('C'));
  ok('包含写日记的指令', ctx.includes('第一人称') && ctx.includes('内心小记'));

  const empty = buildDiaryPrompt({});
  ok('全空时仍返回写日记指令(单段)', empty.includes('内心小记') && empty.split('\n\n').length === 1);
}

console.log(`\nM9 每日训练 全部 ${passed} 条断言通过`);
