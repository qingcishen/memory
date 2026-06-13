// M7 纯逻辑测试: 去重指纹。不连网。
// 同一件事的不同写法应指向同一指纹 (命中后强化而非新增)。
import assert from 'node:assert';
import { normalizeForHash, dedupHash, findDuplicate } from '../src/dedup.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('normalizeForHash / dedupHash');
{
  ok('去标点+折叠空白后一致', normalizeForHash('诗雅 讨厌香菜。') === normalizeForHash('诗雅讨厌香菜'));
  ok('同义写法 → 同一 hash', dedupHash('诗雅讨厌香菜！') === dedupHash('诗雅讨厌香菜'));
  ok('大小写不敏感', dedupHash('Hello World') === dedupHash('helloworld'));
  ok('不同内容 → 不同 hash', dedupHash('诗雅讨厌香菜') !== dedupHash('诗雅喜欢香菜'));
  ok('空串 → null', dedupHash('   。、！') === null);
  ok('hash 稳定可重复', dedupHash('生日 12-15') === dedupHash('生日 12-15'));
}

console.log('findDuplicate (在现存里精确判重)');
{
  const existing = [
    { id: 'a', dedup_hash: dedupHash('诗雅讨厌香菜') },
    { id: 'b', dedup_hash: dedupHash('诗雅在备考') },
  ];
  ok('命中同指纹返回那条', findDuplicate(dedupHash('诗雅讨厌香菜！'), existing)?.id === 'a');
  ok('无命中返回 null', findDuplicate(dedupHash('全新的事'), existing) === null);
  ok('hash 为 null 时返回 null', findDuplicate(null, existing) === null);
}

console.log(`\nM7 全部 ${passed} 条断言通过 ✅`);
