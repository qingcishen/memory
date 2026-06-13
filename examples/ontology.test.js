// M0 纯逻辑测试: 两层记忆本体 + fact_core 不变式。不连网。
// 这里的"不变式"是整个激进路线的安全红线, CI 必须 100% 通过。
import assert from 'node:assert';
import {
  normalizeMemory,
  applyAffectUpdate,
  assertFactCorePreserved,
} from '../src/ontology.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};
const throws = (name, fn) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert.ok(threw, name);
  console.log('  ✓', name);
  passed++;
};

console.log('normalizeMemory (两层规范化)');
{
  const m = normalizeMemory({
    type: 'episode',
    fact_core: '  我们在西湖淋了雨  ',
    narrative: '虽然狼狈但挺浪漫',
    subject_kind: 'dyad',
    affect: { valence: 0.8, intensity: 0.9 },
    importance: 9,
  });
  ok('fact_core 去空白', m.fact_core === '我们在西湖淋了雨');
  ok('narrative 保留', m.narrative === '虽然狼狈但挺浪漫');
  ok('dyad 主体被识别', m.subject_kind === 'dyad');
  ok('content 默认等于 fact_core', m.content === m.fact_core);
  ok('emotion 镜像 intensity', m.emotion === 0.9);
}
{
  const bad = normalizeMemory({ content: '诗雅讨厌香菜', subject_kind: 'xxx', affect: { valence: 5, intensity: -2 } });
  ok('无 fact_core 时回退到 content', bad.fact_core === '诗雅讨厌香菜');
  ok('非法 subject_kind 归 user', bad.subject_kind === 'user');
  ok('valence 越界裁剪到 1', bad.affect_valence === 1);
  ok('intensity 越界裁剪到 0', bad.affect_intensity === 0);
}

console.log('applyAffectUpdate (情感层有界重构)');
{
  const existing = { fact_core: '那次吵架', affect_valence: -0.8, affect_intensity: 0.9, narrative: '她很受伤', reconsolidation_count: 0 };
  const next = applyAffectUpdate(existing, { affect_valence: 0.5, narrative: '现在想想也没什么' }, { clamp: 0.15 });
  ok('fact_core 原样不变', next.fact_core === '那次吵架');
  ok('valence 朝目标走但单步不超过 clamp', Math.abs(next.affect_valence - (-0.8 + 0.15)) < 1e-9);
  ok('narrative 被重写', next.narrative === '现在想想也没什么');
  ok('reconsolidation_count 自增', next.reconsolidation_count === 1);
}
{
  // 多次重构应单调靠拢, 但永不越过目标(防失真累积/反向)
  let mem = { fact_core: 'x', affect_valence: -1, affect_intensity: 0.5 };
  for (let i = 0; i < 100; i++) mem = { ...mem, ...applyAffectUpdate(mem, { affect_valence: 1 }, { clamp: 0.1 }) };
  ok('反复靠拢收敛到目标且不越界', Math.abs(mem.affect_valence - 1) < 1e-9);
}
{
  // fact_locked: 连情感层都冻结(生日/承诺这类硬事实)
  const locked = { fact_core: '生日 12 月 15 日', affect_valence: 0.2, affect_intensity: 0.3, fact_locked: true };
  const next = applyAffectUpdate(locked, { affect_valence: 0.9, narrative: '乱改' });
  ok('fact_locked 时 valence 不动', next.affect_valence === 0.2);
  ok('fact_locked 时 narrative 不动', next.narrative == null ? locked.narrative == null : next.narrative === (locked.narrative ?? null));
  ok('fact_locked 时 fact_core 不动', next.fact_core === '生日 12 月 15 日');
}

console.log('assertFactCorePreserved (红线守卫)');
ok('fact_core 一致 → 通过', assertFactCorePreserved({ fact_core: 'a' }, { fact_core: 'a' }) === true);
throws('fact_core 被改 → 必须抛错', () => assertFactCorePreserved({ fact_core: 'a' }, { fact_core: 'b' }));
throws('任意重构后改了 fact_core → 抛错', () => {
  const before = { fact_core: '那次吵架', affect_valence: -0.8 };
  const tampered = { ...applyAffectUpdate(before, { affect_valence: 0.5 }), fact_core: '那次没吵架' }; // 模拟越权篡改
  assertFactCorePreserved(before, tampered);
});

console.log(`\nM0 全部 ${passed} 条断言通过 ✅`);
