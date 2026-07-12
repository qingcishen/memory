import assert from 'node:assert';
import { buildConversationGoals, goalsToPrompt } from '../src/orchestrator/goals.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('G1 conversation goals');
{
  const goals = buildConversationGoals({
    dueItems: [{ id: 'p1', content: '问问他面试怎么样了' }],
    desires: { attention: 0.1, sharing: 0.9, comfort: 0.1, security: 0.1 },
    storyBeat: { content: '她今天遇到一个新项目' },
  });
  ok('到期 prospective 进入目标栈', goals.some((g) => g.kind === 'prospective' && g.text.includes('面试')));
  ok('高分享欲把今日故事拍变成自然分享目标', goals.some((g) => g.kind === 'desire' && g.text.includes('新项目')));
  const prompt = goalsToPrompt(goals);
  ok('目标栈 prompt 带本轮意图槽', prompt.includes('【本轮意图】') && prompt.includes('自然时机'));
}

{
  const goals = buildConversationGoals({
    dueItems: [
      { id: 'p1', content: '问问生日计划' },
      { id: 'p2', content: '问问体检结果' },
      { id: 'p3', content: '问问旅行行李' },
    ],
    desires: { attention: 0, sharing: 0, comfort: 0, security: 0 },
  });
  ok('目标栈最多保留三项', goals.length === 2);
  ok('低需求时不硬塞 desire 目标', goals.every((g) => g.kind === 'prospective'));
}

console.log(`\nG1 全部 ${passed} 条断言通过 ✅`);
