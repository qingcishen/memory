// 主动性 scheduler/rate limiter 纯逻辑测试。不连网。
import assert from 'node:assert';
import {
  ProactiveScheduler,
  MemoryRateLimitStore,
  SupabaseRateLimitStore,
  canSendProactive,
  isQuietHour,
  markProactiveSent,
  normalizeRateLimitState,
  pickSilenceTier,
  pickBedtimeTier,
} from '../src/orchestrator/index.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

const utc = (iso) => new Date(iso).getTime();
const policy = {
  minIntervalMinutes: 180,
  maxPerDay: 2,
  quietHours: { start: 23, end: 8 },
  timezoneOffsetMinutes: 0,
};

console.log('isQuietHour / canSendProactive');
{
  ok('normalizeRateLimitState 会忽略非法时间', normalizeRateLimitState({ sentAt: ['bad', '2026-06-14T10:00:00Z'] }).sentAt.length === 1);
  ok('23:30 在安静时间内', isQuietHour(utc('2026-06-14T23:30:00Z'), policy.quietHours, 0));
  ok('12:00 不在安静时间内', !isQuietHour(utc('2026-06-14T12:00:00Z'), policy.quietHours, 0));

  const empty = canSendProactive({}, utc('2026-06-14T12:00:00Z'), policy);
  ok('无历史且非安静时间允许发送', empty.ok);

  const cooled = canSendProactive({ sentAt: ['2026-06-14T10:00:00.000Z'] }, utc('2026-06-14T12:00:00Z'), policy);
  ok('未过最小间隔时被 cooldown 拦住', !cooled.ok && cooled.reason === 'cooldown');

  const daily = canSendProactive(
    { sentAt: ['2026-06-14T09:00:00.000Z', '2026-06-14T13:00:00.000Z'] },
    utc('2026-06-14T17:00:00Z'),
    policy
  );
  ok('超过每日上限时被 daily_limit 拦住', !daily.ok && daily.reason === 'daily_limit');

  const quiet = canSendProactive({}, utc('2026-06-14T23:30:00Z'), policy);
  ok('安静时间优先拦住', !quiet.ok && quiet.reason === 'quiet_hours');
}

console.log('markProactiveSent');
{
  const state = markProactiveSent({ sentAt: ['2026-06-14T10:00:00.000Z'] }, utc('2026-06-14T14:00:00Z'), policy);
  ok('发送后追加 sentAt', state.sentAt.length === 2);
  ok('保存 policy 摘要', state.policy.maxPerDay === 2);
}

function makeOrchestrator() {
  return {
    userId: 'u_sched',
    calls: [],
    async proactiveTick(ctx) {
      this.calls.push(ctx);
      return ctx.reason.includes('skip-me') ? null : `主动消息: ${ctx.reason}`;
    },
  };
}

console.log('ProactiveScheduler.tick');
{
  const delivered = [];
  const fired = [];
  const dueItems = [{ id: 'p1', content: '问问面试怎么样了' }];
  const store = new MemoryRateLimitStore();
  const orch = makeOrchestrator();
  const scheduler = new ProactiveScheduler({
    orchestrator: orch,
    stateStore: store,
    policy,
    clock: () => utc('2026-06-14T12:00:00Z'),
    getDueItems: async () => dueItems,
    markFired: async (ids) => fired.push(...ids),
    deliver: async (payload) => delivered.push(payload),
  });

  const first = await scheduler.tick();
  ok('允许时发送主动消息', first.sent && first.message.includes('面试'));
  ok('deliver 收到消息和 dueItems', delivered[0].message === first.message && delivered[0].dueItems.length === 1);
  ok('到期事项发送后 markFired', fired[0] === 'p1');
  ok('orchestrator 收到 shouldSend=true', orch.calls[0].shouldSend === true);

  const second = await scheduler.tick({ now: utc('2026-06-14T13:00:00Z') });
  ok('第二次太近被 cooldown 拦住', !second.sent && second.reason === 'cooldown');
}

console.log('ProactiveScheduler.tick 降级路径');
{
  const scheduler = new ProactiveScheduler({
    orchestrator: makeOrchestrator(),
    stateStore: new MemoryRateLimitStore(),
    policy,
    clock: () => utc('2026-06-14T12:00:00Z'),
    getDueItems: async () => [],
  });
  const skipped = await scheduler.tick({ reason: 'skip-me' });
  ok('orchestrator 返回 null 时报告 orchestrator_skipped', !skipped.sent && skipped.reason === 'orchestrator_skipped');
}

console.log('pickSilenceTier / pickBedtimeTier (P1 分级主动性, 纯逻辑)');
{
  const now = utc('2026-06-14T12:00:00Z');
  ok('lastUserMessageAt 为 null → 不触发', pickSilenceTier(now, null) === null);
  ok('1h 未到档 → 不触发', pickSilenceTier(now, utc('2026-06-14T11:00:00Z')) === null);

  const excuse = pickSilenceTier(now, utc('2026-06-14T09:30:00Z')); // 2.5h
  ok('2-4h → excuse 档', excuse?.tier === 'excuse');

  const direct = pickSilenceTier(now, utc('2026-06-14T07:00:00Z')); // 5h
  ok('4-6h → direct 档', direct?.tier === 'direct');

  const miss = pickSilenceTier(now, utc('2026-06-14T04:00:00Z')); // 8h
  ok('>6h → miss 档', miss?.tier === 'miss');
  ok('miss 档理由提到沉默时长', miss.reason.includes('小时没说话'));

  const sleepWindow = { from: 30, to: 8 * 60 }; // 00:30-08:00
  const beforeBed = pickBedtimeTier(new Date(2026, 5, 14, 23, 45).getTime(), sleepWindow);
  ok('睡前 60min 内 → bedtime 档', beforeBed?.tier === 'bedtime');

  const notBed = pickBedtimeTier(new Date(2026, 5, 14, 20, 0).getTime(), sleepWindow);
  ok('离睡觉还早 → 不触发', notBed === null);
  ok('无 sleepWindow → 不触发', pickBedtimeTier(new Date(2026, 5, 14, 23, 45).getTime(), null) === null);
}

console.log('ProactiveScheduler.tick 分级主动性优先级链 (P1)');
{
  // 无 ctx.reason / dueItems / 不在睡前 → 落到沉默分级 (8h 没说话 → miss 档)
  const orchSilence = makeOrchestrator();
  const silenceScheduler = new ProactiveScheduler({
    orchestrator: orchSilence,
    stateStore: new MemoryRateLimitStore(),
    policy,
    clock: () => utc('2026-06-14T12:00:00Z'),
    getDueItems: async () => [],
    sleepWindow: { from: 30, to: 8 * 60 }, // 00:30-08:00, 中午不在睡前窗口内
    getLastUserMessageAt: async () => utc('2026-06-14T04:00:00Z'), // 8h 前
  });
  const silenceResult = await silenceScheduler.tick();
  ok('落到 silence 档 (miss)', silenceResult.sent && silenceResult.reason.includes('小时没说话'));

  // 同时处于睡前窗口 + 长沉默 → bedtime 优先于 silence (关闭安静时段避免 23:45 被拦)
  const orchBedtime = makeOrchestrator();
  const bedtimeScheduler = new ProactiveScheduler({
    orchestrator: orchBedtime,
    stateStore: new MemoryRateLimitStore(),
    policy: { ...policy, quietHours: null },
    clock: () => new Date(2026, 5, 14, 23, 45).getTime(),
    getDueItems: async () => [],
    sleepWindow: { from: 30, to: 8 * 60 },
    getLastUserMessageAt: async () => utc('2026-06-14T04:00:00Z'),
  });
  const bedtimeResult = await bedtimeScheduler.tick();
  ok('bedtime 档优先于 silence 档', bedtimeResult.sent && bedtimeResult.reason.includes('晚安'));

  // dueItems 优先于 bedtime/silence
  const orchDue = makeOrchestrator();
  const dueScheduler = new ProactiveScheduler({
    orchestrator: orchDue,
    stateStore: new MemoryRateLimitStore(),
    policy: { ...policy, quietHours: null },
    clock: () => new Date(2026, 5, 14, 23, 45).getTime(),
    getDueItems: async () => [{ id: 'p1', content: '问问面试怎么样了' }],
    sleepWindow: { from: 30, to: 8 * 60 },
    getLastUserMessageAt: async () => utc('2026-06-14T04:00:00Z'),
  });
  const dueResult = await dueScheduler.tick();
  ok('到期事项优先于 bedtime/silence', dueResult.sent && dueResult.reason.includes('面试'));
}

function makeFakeSupabase(initialState = null) {
  const calls = { select: [], upsert: [] };
  return {
    calls,
    from(table) {
      const query = {
        table,
        selected: null,
        userId: null,
        select(cols) {
          this.selected = cols;
          calls.select.push({ table, cols });
          return this;
        },
        eq(col, value) {
          if (col === 'user_id') this.userId = value;
          return this;
        },
        async maybeSingle() {
          return initialState ? { data: { state: initialState }, error: null } : { data: null, error: null };
        },
        async upsert(row, opts) {
          calls.upsert.push({ table, row, opts });
          return { error: null };
        },
      };
      return query;
    },
  };
}

console.log('SupabaseRateLimitStore (DB-backed stateStore)');
{
  const client = makeFakeSupabase({ sentAt: ['bad', '2026-06-14T10:00:00Z'] });
  const store = new SupabaseRateLimitStore({ client });
  const loaded = await store.load({ userId: 'u_db' });
  ok('load 从 proactive_rate_limits 读取并规范化 state', loaded.sentAt.length === 1 && client.calls.select[0].table === 'proactive_rate_limits');

  const saved = await store.save({ sentAt: ['2026-06-14T12:00:00Z'] }, { userId: 'u_db' });
  ok('save 返回规范化 state', saved.sentAt[0] === '2026-06-14T12:00:00.000Z');
  ok('save 使用 user_id upsert', client.calls.upsert[0].row.user_id === 'u_db');
  ok('save 写入 state json', client.calls.upsert[0].row.state.sentAt.length === 1);
}

console.log(`\nScheduler 全部 ${passed} 条断言通过`);
