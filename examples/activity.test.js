// L3 纯逻辑测试: 生活模拟 (作息活动模板, 可重现随机)。不连网。
import assert from 'node:assert';
import { currentActivity, isSleeping, dateKey, hashString, mulberry32, pickSeeded, makeScheduleActivityFn, shanghaiWallClock } from '../src/state/activity.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

// 固定某天某时刻 (本地时间)
const at = (hour) => new Date(2026, 5, 15, hour, 0, 0).getTime();

console.log('currentActivity 可重现 (同 userId/companionId/日期/小时 → 同活动)');
{
  const a1 = currentActivity(at(10), { userId: 'u1', companionId: 'keke' });
  const a2 = currentActivity(at(10), { userId: 'u1', companionId: 'keke' });
  ok('同一小时稳定', a1 === a2 && typeof a1 === 'string' && a1.length > 0);

  // 不同 companion 种子不同, 活动可不同 (至少不强制相同)
  const b = currentActivity(at(10), { userId: 'u1', companionId: 'leng' });
  ok('不同 companion 各算各的 (都是合法活动)', typeof b === 'string' && b.length > 0);

  // 跨小时可变 (上午工作 vs 午饭)
  const noon = currentActivity(at(12), { userId: 'u1', companionId: 'keke' });
  ok('午间是吃饭/午休类活动', /午饭|午休/.test(noon));
}

console.log('作息段覆盖');
{
  ok('深夜在睡觉', /睡着/.test(currentActivity(at(3), { userId: 'u1' })));
  ok('isSleeping 深夜为真', isSleeping(at(3)) === true);
  ok('isSleeping 白天为假', isSleeping(at(14)) === false);
  ok('晚间是休闲类活动', /追剧|看书|健身|手机|朋友/.test(currentActivity(at(20), { userId: 'u1' })));
}

console.log('生病覆盖正常作息');
{
  const sick = currentActivity(at(14), { userId: 'u1', sickUntil: new Date(at(20)).toISOString() });
  ok('病中(sick_until 未到)一律休息', /生病|休息/.test(sick));
  const recovered = currentActivity(at(14), { userId: 'u1', sickUntil: new Date(at(8)).toISOString() });
  ok('病好(sick_until 已过)回归正常作息', !/生病/.test(recovered));
}

console.log('shanghaiWallClock (作息按 Asia/Shanghai 固定 +8h, 不依赖服务器本地时区)');
{
  // 2026-06-14T13:11:00Z = 北京时间 2026-06-14 21:11 (晚上9点); 用 Date.UTC 构造输入、getUTC* 读取输出,
  // 全程不经过服务器本地时区, 复现"现在明明是晚上9点"的场景。
  const utcMs = Date.UTC(2026, 5, 14, 13, 11, 0);
  const wall = shanghaiWallClock(utcMs);
  ok('UTC 13:11 → 北京时间 21:11', wall.getUTCHours() === 21 && wall.getUTCMinutes() === 11);
  ok('日期不跨天时保持同一天', wall.getUTCDate() === 14);
  ok('currentActivity 在晚上9点不会落到上午的作息段', /追剧|看书|健身|手机|朋友/.test(currentActivity(utcMs, { userId: 'u1' })));
  ok('dateKey 按北京挂钟日期, 不受服务器本地时区影响', dateKey(utcMs) === '2026-06-14');

  // 跨午夜: UTC 16:30 (次日 00:30 北京) 应算入下一天且落入睡眠段
  const utcLate = Date.UTC(2026, 5, 14, 16, 30, 0);
  const wallLate = shanghaiWallClock(utcLate);
  ok('UTC 16:30 → 北京时间次日 00:30', wallLate.getUTCHours() === 0 && wallLate.getUTCDate() === 15);
  ok('dateKey 跨午夜后归入下一天', dateKey(utcLate) === '2026-06-15');
}

console.log('helpers (纯, 可重现)');
{
  ok('dateKey 格式 YYYY-MM-DD', dateKey(new Date(2026, 5, 15)) === '2026-06-15');
  ok('hashString 确定', hashString('abc') === hashString('abc') && hashString('abc') !== hashString('abd'));
  ok('mulberry32 同种子同序列', mulberry32(123)() === mulberry32(123)());
  ok('pickSeeded 在数组内且稳定', (() => {
    const arr = ['a', 'b', 'c'];
    const p = pickSeeded(arr, 42);
    return arr.includes(p) && p === pickSeeded(arr, 42);
  })());
  ok('pickSeeded 空数组 → null', pickSeeded([], 1) === null);
}

console.log('makeScheduleActivityFn (角色专属作息)');
{
  const fn = makeScheduleActivityFn({
    schedule: [
      { from: '09:30', to: '12:00', activity: '公司开会/看项目' },
      { from: '20:00', to: '21:00', activity: '健身或和逸晨待着' },
    ],
    sleep: '00:30-08:00',
  });
  ok('日程段内 → 用该段活动', /公司开会|看项目/.test(fn(at(10), { userId: 'u1' })));
  ok('睡眠区间 → 睡着了', fn(at(2)) === '睡着了');
  ok('日程没覆盖的时段 → 回退通用作息(非空)', typeof fn(at(15), { userId: 'u1' }) === 'string' && fn(at(15), { userId: 'u1' }).length > 0);
  ok('生病优先休息', /生病|休息/.test(fn(at(10), { sickUntil: new Date(at(18)).toISOString() })));
  ok('"/" 分隔的段按种子可重现', fn(at(10), { userId: 'u1', companionId: 'k' }) === fn(at(10), { userId: 'u1', companionId: 'k' }));
}

console.log(`\nL3 生活模拟 全部 ${passed} 条断言通过`);
