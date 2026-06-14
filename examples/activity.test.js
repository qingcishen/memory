// L3 纯逻辑测试: 生活模拟 (作息活动模板, 可重现随机)。不连网。
import assert from 'node:assert';
import { currentActivity, isSleeping, dateKey, hashString, mulberry32, pickSeeded } from '../src/state/activity.js';

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

console.log(`\nL3 生活模拟 全部 ${passed} 条断言通过`);
