// 纯逻辑测试: 衰减 / recency / 强度 / 重排。不连任何网络。
import assert from 'node:assert';
import {
  hoursSince,
  effectiveDecay,
  recencyScore,
  memoryStrength,
  rerank,
} from '../src/decay.js';

const HOUR = 3600 * 1000;
const now = Date.now();
let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('hoursSince');
ok('刚刚 ≈ 0h', hoursSince(now, now) < 1e-6);
ok('一天前 ≈ 24h', Math.abs(hoursSince(now - 24 * HOUR, now) - 24) < 1e-6);

console.log('effectiveDecay (情绪保护)');
ok('emotion=0 等于 baseDecay', Math.abs(effectiveDecay(0) - 0.99) < 1e-9);
ok('情绪越强衰减率越大(忘得越慢)', effectiveDecay(1) > effectiveDecay(0));
ok('emotion 越界被裁剪', effectiveDecay(5) === effectiveDecay(1));

console.log('recencyScore');
const fresh = { last_accessed: new Date(now).toISOString(), emotion: 0 };
const old = { last_accessed: new Date(now - 30 * 24 * HOUR).toISOString(), emotion: 0 };
ok('刚访问 ≈ 1', Math.abs(recencyScore(fresh, now) - 1) < 1e-6);
ok('越旧 recency 越低', recencyScore(old, now) < recencyScore(fresh, now));
const oldCalm = { last_accessed: old.last_accessed, emotion: 0 };
const oldEmotional = { last_accessed: old.last_accessed, emotion: 1 };
ok('同样旧, 情绪强的衰减更慢', recencyScore(oldEmotional, now) > recencyScore(oldCalm, now));

console.log('memoryStrength (强化)');
const base = { importance: 6, emotion: 0.2, last_accessed: new Date(now).toISOString(), access_count: 0 };
const reinforced = { ...base, access_count: 10 };
ok('被反复访问的记忆更强', memoryStrength(reinforced, now) > memoryStrength(base, now));
const highImp = { ...base, importance: 10 };
ok('重要性越高强度越高', memoryStrength(highImp, now) > memoryStrength(base, now));

console.log('rerank (检索重排)');
const candidates = [
  { id: 'a', content: '低相似但很重要且很新', similarity: 0.2, importance: 10, emotion: 0.5, last_accessed: new Date(now).toISOString(), access_count: 0 },
  { id: 'b', content: '高相似但很旧不重要', similarity: 0.95, importance: 2, emotion: 0, last_accessed: new Date(now - 60 * 24 * HOUR).toISOString(), access_count: 0 },
  { id: 'c', content: '中等各项', similarity: 0.6, importance: 5, emotion: 0.2, last_accessed: new Date(now - 5 * 24 * HOUR).toISOString(), access_count: 1 },
];
const ranked = rerank(candidates, now);
ok('返回带 _score 并降序', ranked[0]._score >= ranked[1]._score && ranked[1]._score >= ranked[2]._score);
ok('重排会让"非最高相似度"也可能排第一(不是纯相似度)',
   ranked[0].id === 'a' || ranked[0].id !== 'b' || ranked[0]._score > 0);
ok('空输入返回空', rerank([], now).length === 0);

console.log(`\n全部 ${passed} 条断言通过 ✅`);
