// M5 纯逻辑测试: 预期记忆 (面向未来)。不连网。
// 验收 (见 docs/DEVELOPMENT.md M5):
//   - "我明天有面试" → 自动排程; 到次日检查时返回该预期项
//   - cue 型: 再提相关话题时被语境触发
//   - 已 fired / 过期 不再打扰
import assert from 'node:assert';
import { relativeTriggerAt, detectProspective, isDue, isExpired } from '../src/memory/prospective.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;
const now = new Date('2026-06-13T10:00:00').getTime();

console.log('relativeTriggerAt (相对说法 → 绝对时刻)');
{
  const tmr = relativeTriggerAt('我明天面试', now);
  ok('"明天" 排到次日', tmr && new Date(tmr).getDate() === new Date(now + DAY).getDate());
  ok('"明天" 默认排在 defaultHour', new Date(tmr).getHours() === PARAMS.prospective.defaultHour);
  ok('"今晚" 排在当天 20:00', new Date(relativeTriggerAt('今晚一起吃饭', now)).getHours() === 20);
  const soon = relativeTriggerAt('待会去体检', now);
  ok('"待会" 排在 ~2h 后', Math.abs(new Date(soon).getTime() - (now + 2 * HOUR)) < 1000);
  ok('没有时间词 → null', relativeTriggerAt('今天天气不错', now) === null);
}

console.log('detectProspective (未来时间词 + 值得关心的事件)');
{
  const p = detectProspective([{ role: 'user', content: '我明天有个很重要的面试, 好紧张' }], now, '诗雅');
  ok('识别出预期记忆', p !== null);
  ok('trigger_kind=time', p.trigger_kind === 'time');
  ok('content 提到要回来关心', p.content.includes('面试') && p.content.includes('诗雅'));
  ok('只有时间没事件 → 不记 (太琐碎)', detectProspective([{ role: 'user', content: '我明天再说吧' }], now) === null);
  ok('只有事件没时间 → 不记', detectProspective([{ role: 'user', content: '上次面试好难' }], now) === null);
  ok('AI 的话不触发', detectProspective([{ role: 'assistant', content: '你明天面试加油' }], now) === null);
}

console.log('isDue / isExpired (time 型)');
{
  const at = relativeTriggerAt('我明天面试', now);
  const item = { status: 'pending', trigger_kind: 'time', trigger_at: at };
  ok('触发前不 due', isDue(item, {}, now) === false);
  // 次日 defaultHour 之后
  const after = new Date(at).getTime() + HOUR;
  ok('到点后 due', isDue(item, {}, after) === true);
  ok('已 fired 的不再 due', isDue({ ...item, status: 'fired' }, {}, after) === false);

  const grace = PARAMS.prospective.graceHours;
  ok('过触发点未超 grace 不算过期', isExpired(item, after) === false);
  ok('超过 grace 算过期', isExpired(item, new Date(at).getTime() + (grace + 1) * HOUR) === true);
  ok('过期后不再 due (不打扰)', isDue(item, {}, new Date(at).getTime() + (grace + 1) * HOUR) === false);
}

console.log('isDue (cue 型: 语境相似度触发)');
{
  const cue = { status: 'pending', trigger_kind: 'cue', cue_embedding: [1, 0, 0] };
  ok('语境相近 → 触发', isDue(cue, { queryVec: [0.99, 0.1, 0] }, now) === true);
  ok('语境不相关 → 不触发', isDue(cue, { queryVec: [0, 1, 0] }, now) === false);
  ok('缺向量 → 不触发 (不误报)', isDue(cue, {}, now) === false);
}

console.log(`\nM5 全部 ${passed} 条断言通过 ✅`);
