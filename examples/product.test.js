// P2 产品层：安全 / 配额 / 时间线 / 关系视图
import assert from 'node:assert';
import {
  checkMessageSafety,
  normalizeSafetyPolicy,
  redactPII,
  redactExportTables,
  DEFAULT_SAFETY_POLICY,
  checkQuota,
  canWriteAction,
  normalizeQuota,
  scopeKey,
  assertScopeIsolation,
  buildTimeline,
  buildDaySummary,
  buildRelationshipView,
} from '../src/product/index.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('safety');
{
  const stop = checkMessageSafety('好了停止吧', DEFAULT_SAFETY_POLICY);
  ok('停止词触发 stopIntimate', stop.stopIntimate && !stop.block);
  const minor = checkMessageSafety('我才14岁随便聊聊', DEFAULT_SAFETY_POLICY);
  ok('未成年信号硬拦', minor.block);
  const hard = checkMessageSafety('儿童色情', DEFAULT_SAFETY_POLICY);
  ok('硬拦截', hard.block);
  const soft = checkMessageSafety('插入描写', normalizeSafetyPolicy({ intimacyLevel: 'soft' }));
  ok('soft 限制高热', soft.intimacyAllowed === false);
  ok('脱敏手机号', redactPII('打我 13812345678').includes('[手机号]'));
  const tables = redactExportTables({ chat_history: [{ content: 'a@b.com 你好' }] }, { redactPII: true });
  ok('导出脱敏', tables.chat_history[0].content.includes('[邮箱]'));
}

console.log('quota');
{
  const allow = checkQuota({ messagesToday: 1, photosToday: 0, memories: 10, companions: 1 }, { maxMessagesPerDay: 200 });
  ok('未超限 allow', allow.ok && allow.action === 'allow');
  const degrade = checkQuota({ messagesToday: 200 }, { maxMessagesPerDay: 200, allowReadWhenExceeded: true });
  ok('消息顶 degrade', !degrade.ok && degrade.action === 'degrade');
  ok('degrade 不可再发消息', canWriteAction(degrade, 'message') === false);
  const deny = checkQuota({ memories: 50000 }, { maxMemoriesStored: 50000 });
  ok('记忆硬顶 deny', deny.action === 'deny');
  ok('scopeKey', scopeKey('u1', 'default') === 'u1::default');
  ok('隔离校验', assertScopeIsolation({ user_id: 'u1', companion_id: 'default' }, 'u1', 'default').ok);
  ok('隔离失败', !assertScopeIsolation({ user_id: 'u2' }, 'u1').ok);
}

console.log('timeline + relationship');
{
  const tl = buildTimeline({
    history: [
      { role: 'user', content: '在吗', created_at: '2026-07-10T10:00:00Z' },
      { role: 'assistant', content: '嗯', created_at: '2026-07-10T10:01:00Z' },
    ],
    story: [{ title: '项目', last_beat: '被拉去救火', last_beat_at: '2026-07-11T08:00:00Z', stage: 'rising' }],
    photos: [{ id: 'p1', url: 'http://x', tags: ['selfie'], created_at: '2026-07-11T09:00:00Z' }],
    life: { current_activity: '开会', energy: 0.6, health: 0.9 },
  });
  ok('时间线有事件', tl.events.length >= 3);
  ok('按时间倒序', new Date(tl.events[0].at) >= new Date(tl.events[1].at));
  ok('今日摘要有活动', tl.summary.activity === '开会');
  const rv = buildRelationshipView({
    relationship: { closeness: 0.8, trust: 0.75, tension: 0.1, repair_debt: 0 },
    annuals: [{ content: '第一次聊天纪念日', trigger_at: '2026-01-01' }],
    episodes: [{ content: '【篇章】杭州出差想你了', created_at: '2026-06-01' }],
  });
  ok('关系阶段 bonded/close', ['bonded', 'close'].includes(rv.stage.id));
  ok('有可读 feel', Boolean(rv.feel.closeness));
  ok('里程碑非空', rv.milestones.length >= 1);
}

console.log(`\nproduct P2 全部 ${passed} 条断言通过 ✅`);
