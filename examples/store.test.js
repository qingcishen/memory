// P1 工程债 #10 纯逻辑测试: 事务与并发写入。不连网。
// storeMemories 插入前会先按 dedup_hash 查现存记忆 (fetchByHashes), 但两个并发 observe()
// 都可能在对方提交之前完成这次查询、都判定 fresh —— 后提交的撞上数据库唯一约束 (23505)。
// isUniqueViolation / resolveInsertConflict 决定这种冲突要不要退化为"强化先到的那条"。
import assert from 'node:assert';
import { isUniqueViolation, resolveInsertConflict } from '../src/store.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('isUniqueViolation (识别 Postgres 唯一约束冲突)');
{
  ok('23505 → true', isUniqueViolation({ code: '23505' }));
  ok('其它错误码 → false', !isUniqueViolation({ code: '23503' }));
  ok('无错误 → false', !isUniqueViolation(null));
  ok('无 code 字段 → false', !isUniqueViolation({ message: 'boom' }));
}

console.log('resolveInsertConflict (并发插入冲突 → 乐观重试决策)');
{
  const existing = { id: 'old-1', dedup_hash: 'h1', access_count: 2, access_log: [] };
  const existingByHash = new Map([['h1', existing]]);

  const resolved = resolveInsertConflict({ code: '23505' }, 'h1', existingByHash);
  ok('23505 + 命中现存记忆 → retry', resolved.retry === true);
  ok('retry 时带上要强化的那条', resolved.reinforce === existing);

  ok('非 23505 错误 → 不重试, 照常抛出', resolveInsertConflict({ code: '23503' }, 'h1', existingByHash).retry === false);
  ok('dedup_hash 为 null → 不重试', resolveInsertConflict({ code: '23505' }, null, existingByHash).retry === false);
  ok('现存映射里没这个 hash → 不重试', resolveInsertConflict({ code: '23505' }, 'h2', existingByHash).retry === false);
}

console.log(`\nConcurrency 全部 ${passed} 条断言通过 ✅`);
