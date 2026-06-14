// M7 纯逻辑测试: 去重指纹。不连网。
// 同一件事的不同写法应指向同一指纹 (命中后强化而非新增)。
import assert from 'node:assert';
import { normalizeForHash, dedupHash, findDuplicate, isNearDuplicate, findNearDuplicate } from '../src/dedup.js';

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

console.log('isNearDuplicate / findNearDuplicate (近义去重: embedding 近邻判重)');
{
  ok('相似度达到阈值算近义重复', isNearDuplicate(0.97));
  ok('相似度略低于阈值不算', !isNearDuplicate(0.9));
  ok('非数字相似度不算', !isNearDuplicate(undefined));
  ok('阈值可自定义', isNearDuplicate(0.9, 0.85));

  const candidates = [
    { id: 'a', similarity: 0.99 },
    { id: 'b', similarity: 0.9 },
  ];
  ok('命中候选中第一条达到阈值的', findNearDuplicate(candidates)?.id === 'a');
  ok('全部低于阈值时返回 null', findNearDuplicate([{ id: 'c', similarity: 0.85 }]) === null);
  ok('空候选返回 null', findNearDuplicate([]) === null);
}

console.log(`\nM7 全部 ${passed} 条断言通过 ✅`);
