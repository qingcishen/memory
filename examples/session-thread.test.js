// 会话线 · 开放问题 · 承诺 · drift · assemble 槽
import assert from 'node:assert';
import {
  emptySessionThread,
  updateSessionThread,
  sessionThreadToPrompt,
  sessionHooksToUnfinished,
  extractOpenQuestions,
  extractCommitments,
  shouldResetSession,
  detectSessionDrift,
  SESSION_IDLE_MS,
} from '../src/companion/sessionThread.js';
import { buildSystemPrompt } from '../src/orchestrator/assemble.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('extract');
{
  ok('开放问句', extractOpenQuestions('周末你有空吗？').length === 1);
  ok('陈述不抽问', extractOpenQuestions('我到家了').length === 0);
  ok('用户承诺', extractCommitments('我周末有空陪你', 'user').some((c) => c.who === 'user'));
  ok('她的约定', extractCommitments('好，明天晚上等你', 'her').length >= 1);
}

console.log('updateSessionThread multi-turn');
{
  let t = emptySessionThread(1_000_000);
  t = updateSessionThread(t, {
    userMessage: '周末你有空吗？',
    reply: '有，周六可以',
    sceneLocks: [],
    now: 1_000_000,
  });
  ok('turnCount=1', t.turnCount === 1);
  ok('记下开放问题或约定', t.openQuestions.length + t.commitments.filter((c) => c.status === 'open').length >= 1);
  ok('有主话题', Boolean(t.primaryTopic));

  t = updateSessionThread(t, {
    userMessage: '加班到吐，老板又甩锅',
    reply: '辛苦了，回来好好睡',
    sceneLocks: [{ id: 'work' }],
    now: 1_000_100,
  });
  ok('主线切到工作', t.primaryTopic === '工作');
  ok('turnCount=2', t.turnCount === 2);

  const prompt = sessionThreadToPrompt(t);
  ok('prompt 含本场在聊', prompt.includes('【本场在聊】'));
  ok('prompt 含主线', prompt.includes('工作'));

  const hooks = sessionHooksToUnfinished(t);
  ok('hooks 可导出', Array.isArray(hooks));
}

console.log('intimate lock + drift');
{
  let t = updateSessionThread(null, {
    userMessage: '想要你，抱紧我',
    reply: '嗯…过来',
    sceneLocks: [{ id: 'intimate' }],
    now: Date.now(),
  });
  ok('亲密主线', t.primaryTopic === '亲密');
  ok('情绪 intimate', t.emotionalTone === 'intimate');
  const bad = detectSessionDrift('好舒服明天上课别怪我', t);
  ok('亲密硬插日程=drift', bad.drift === true);
  const good = detectSessionDrift('慢一点…好满', t);
  ok('顺着亲密不drift', good.drift === false);
}

console.log('reset idle');
{
  const old = updateSessionThread(null, {
    userMessage: '嗨',
    reply: '嗯',
    now: Date.now() - SESSION_IDLE_MS - 1000,
  });
  ok('超时应重置', shouldResetSession(old, Date.now()) === true);
  const fresh = updateSessionThread(old, { userMessage: '新一天', reply: '早', now: Date.now() });
  ok('重置后 turn 从 1', fresh.turnCount === 1);
}

console.log('assemble slot');
{
  const sys = buildSystemPrompt({
    sessionThreadPrompt: '【本场在聊】主线话题：工作。',
    structuredPlanPrompt: '【本轮决策】warm',
  });
  ok('会话线进 system', sys.includes('本场在聊'));
  ok('params 默认开', PARAMS.orchestrator.sessionThread === true);
}

console.log(`\nsession-thread 全部 ${passed} 条断言通过 ✅`);
