// L4 纯逻辑测试: 健康/生病闭环。不连网, 注入固定 rng/now。
import assert from 'node:assert';
import { maybeFallSick, detectCare, applyCare, isSick, isLateNight, updateLateNightStreak } from '../src/state/health.js';
import { dateKey } from '../src/state/activity.js';
import { PARAMS } from '../src/params.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const now = new Date(2026, 5, 15, 14, 0, 0).getTime();
const HOUR = 3600 * 1000;
const healthy = { energy: 0.6, satiety: 0.6, health: 1, current_activity: null, last_slept_at: null, sick_until: null };

console.log('maybeFallSick (低频自动发病, 熬夜抬概率)');
{
  ok('rng 高于概率 → 不发病', maybeFallSick(healthy, now, () => 1).sick === false);
  const fell = maybeFallSick(healthy, now, () => 0);
  ok('rng 低于概率 → 发病', fell.sick === true);
  ok('发病: health 下跌', fell.state.health < healthy.health);
  ok('发病: 设了 sick_until 在未来', new Date(fell.state.sick_until).getTime() > now);
  ok('发病: 产出心情下跌增量', fell.moodDelta.mood.valence < 0);

  // 已在病中不重复发病
  const sickState = { ...healthy, sick_until: new Date(now + 10 * HOUR).toISOString() };
  ok('已在病中 → 不重复发病', maybeFallSick(sickState, now, () => 0).sick === false);

  // 熬夜抬概率: rng=0.04 在基础概率(0.02)之上但在熬夜倍率(0.06)之下
  const wellRested = { ...healthy, last_slept_at: new Date(now - 6 * HOUR).toISOString() };
  const sleepDeprived = { ...healthy, last_slept_at: new Date(now - 30 * HOUR).toISOString() };
  ok('睡眠充足 + rng=0.04 → 不发病', maybeFallSick(wellRested, now, () => 0.04).sick === false);
  ok('熬夜(>20h没睡) + rng=0.04 → 发病', maybeFallSick(sleepDeprived, now, () => 0.04).sick === true);
}

console.log('detectCare (从对方的话里嗅关心)');
{
  ok('"多喝水, 早点睡" → cared', detectCare([{ role: 'user', content: '多喝水, 早点睡' }]).cared === true);
  ok('命中词被收集', detectCare([{ role: 'user', content: '记得吃药, 注意身体' }]).hits.length >= 2);
  ok('只看对方的话, AI 的不算', detectCare([{ role: 'assistant', content: '多喝水' }]).cared === false);
  ok('普通闲聊 → 不算关心', detectCare([{ role: 'user', content: '今天天气不错' }]).cared === false);
}

console.log('applyCare (病中被关心 → 加速康复 + 暖意/亲密增量 + careEvent)');
{
  const sickUntil = new Date(now + 24 * HOUR).toISOString();
  const sick = { ...healthy, health: 0.5, sick_until: sickUntil };
  const r = applyCare(sick, now, ['多喝水']);
  ok('病中被关心 → applied', r.applied === true);
  ok('health 回升', r.state.health > sick.health);
  ok('sick_until 提前(病程缩短)', new Date(r.state.sick_until).getTime() < new Date(sickUntil).getTime());
  ok('产出正向 valence 增量', r.moodDelta.mood.valence > 0);
  ok('产出亲密/信任增量', r.relationshipDelta.relationship.closeness > 0 && r.relationshipDelta.relationship.trust > 0);
  ok('带 careEvent (供写 dyad 记忆)', r.careEvent && Array.isArray(r.careEvent.hits));

  // 没病时关心不触发康复闭环
  const notSick = applyCare(healthy, now, ['多喝水']);
  ok('没生病时被关心 → 不触发闭环', notSick.applied === false && notSick.careEvent === null);
}

console.log('isSick');
{
  ok('sick_until 在未来 → 生病中', isSick({ sick_until: new Date(now + HOUR).toISOString() }, now) === true);
  ok('sick_until 已过 → 没病', isSick({ sick_until: new Date(now - HOUR).toISOString() }, now) === false);
  ok('无 sick_until → 没病', isSick({}, now) === false);
}

console.log('isLateNight / updateLateNightStreak (P2 身体专属参数: 熬夜重定义为对话发生在睡眠时段内)');
{
  const sleepWindow = { from: 30, to: 8 * 60 }; // "00:30-08:00"
  const lateHour = new Date(2026, 5, 15, 2, 0, 0).getTime(); // 02:00, 在窗口内
  const dayHour = new Date(2026, 5, 15, 14, 0, 0).getTime(); // 14:00, 不在窗口内

  ok('凌晨2点落在睡眠窗口内', isLateNight(lateHour, sleepWindow) === true);
  ok('下午2点不在睡眠窗口内', isLateNight(dayHour, sleepWindow) === false);
  ok('无 sleepWindow → 总是 false', isLateNight(lateHour, null) === false);

  const first = updateLateNightStreak({}, lateHour, true);
  ok('首次熬夜 streak=1', first.late_night_streak === 1);
  ok('记录熬夜日期', first.last_late_night_day === dateKey(new Date(lateHour)));

  const sameDay = updateLateNightStreak(first, lateHour + HOUR, true);
  ok('同一天内重复熬夜不重复计数', sameDay.late_night_streak === 1);

  const second = updateLateNightStreak(first, lateHour + 24 * HOUR, true);
  ok('连续第二天熬夜 streak+1', second.late_night_streak === 2);

  const reset = updateLateNightStreak(second, lateHour + 4 * 24 * HOUR, true);
  ok('中断过后再熬夜 → 重新计 1', reset.late_night_streak === 1);

  const unchanged = updateLateNightStreak(second, dayHour, false);
  ok('非熬夜时段不改变 streak/日期', unchanged.late_night_streak === second.late_night_streak && unchanged.last_late_night_day === second.last_late_night_day);
}

console.log('maybeFallSick: sickProbability 覆盖 + 连续熬夜翻倍 (P2 身体专属参数)');
{
  const highProb = maybeFallSick(healthy, now, () => 0.5, 24, { sickProbability: 0.6 });
  ok('sickProbability 覆盖后命中更高概率', highProb.sick === true);
  ok('不覆盖时同样的 rng 不命中(基础概率很低)', maybeFallSick(healthy, now, () => 0.5).sick === false);

  const streaked = { ...healthy, late_night_streak: PARAMS.health.lateNightStreakForDouble };
  ok('未达标连续熬夜 + rng=0.03 → 不发病', maybeFallSick(healthy, now, () => 0.03).sick === false);
  ok('连续熬夜达标(概率翻倍) + rng=0.03 → 发病', maybeFallSick(streaked, now, () => 0.03).sick === true);
}

console.log(`\nL4 健康闭环 全部 ${passed} 条断言通过`);
