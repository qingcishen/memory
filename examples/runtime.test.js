// 后台调度循环测试: 维护/夜间判定 + maintainTick/proactiveTick 委派。不连网, 注入 mock。
import assert from 'node:assert';
import { CompanionRuntime, isNightlyDue, localDayKey } from '../src/runtime/index.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const tz = 8 * 60; // 东八区
const at = (y, m, d, h) => Date.UTC(y, m - 1, d, h - 8, 0, 0); // 给定东八区本地时刻的 UTC 毫秒

console.log('isNightlyDue (每天一次, 本地过点才跑)');
{
  ok('本地凌晨4点后且今天没跑过 → 该跑', isNightlyDue(at(2026, 6, 15, 5), null, 4, tz) === true);
  ok('本地还没到4点 → 不跑', isNightlyDue(at(2026, 6, 15, 2), null, 4, tz) === false);
  const today = localDayKey(at(2026, 6, 15, 5), tz);
  ok('今天已经跑过 → 不重复', isNightlyDue(at(2026, 6, 15, 9), today, 4, tz) === false);
  ok('到了新的一天 → 再跑', isNightlyDue(at(2026, 6, 16, 5), today, 4, tz) === true);
}

console.log('maintainTick (委派 orchestrator.maintain, 夜间标志正确 + 每天只跑一次)');
{
  const calls = [];
  const orch = { async maintain(opts) { calls.push(opts); return 'ok'; } };
  const rt = new CompanionRuntime({ orchestrator: orch, clock: () => at(2026, 6, 15, 5), options: { nightlyHour: 4, timezoneOffsetMinutes: tz } });

  const r1 = await rt.maintainTick();
  ok('首次本地5点 → 跑夜间维护', r1.nightly === true && calls[0].nightly === true);
  const r2 = await rt.maintainTick();
  ok('同一天再 tick → 不再跑夜间 (只常规维护)', r2.nightly === false && calls[1].nightly === false);
  ok('maintain 收到 now', typeof calls[0].now === 'number');
}

console.log('proactiveTick (有 scheduler 才跑, 委派 tick)');
{
  let ticked = 0;
  const orch = { async maintain() {} };
  const sched = { async tick(ctx) { ticked++; return { sent: true, ctx }; } };
  const rt = new CompanionRuntime({ orchestrator: orch, proactiveScheduler: sched, clock: () => 1000 });
  const r = await rt.proactiveTick({ reason: 'x' });
  ok('委派给 ProactiveScheduler.tick', ticked === 1 && r.sent === true);
  ok('带上 now', r.ctx.now === 1000);

  const noSched = new CompanionRuntime({ orchestrator: orch });
  ok('没 scheduler → proactiveTick 返回 null', (await noSched.proactiveTick()) === null);
}

console.log('start/stop (定时器可起可停, 不抛)');
{
  const rt = new CompanionRuntime({ orchestrator: { async maintain() {} }, clock: () => 0, options: { maintainEveryMs: 999999 } });
  rt.start();
  ok('start 后有定时器', rt._timers.length >= 1);
  rt.stop();
  ok('stop 后清空定时器', rt._timers.length === 0);
}

console.log(`\n后台调度 全部 ${passed} 条断言通过`);
