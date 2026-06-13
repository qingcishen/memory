// M3 纯逻辑测试: 重构性记忆。不连网。
// 验收 (见 docs/DEVELOPMENT.md M3):
//   - 一条"吵架"负向记忆 → 模拟和好(状态回正) → 多次 recall 后 affect_valence 明显回暖,
//     但 fact_core 一字未变
//   - 漂移有界: 单次不超过 affectClamp; fact_locked 关不掉 fact_core 保护
import assert from 'node:assert';
import { reconsolidate, shouldRewriteNarrative } from '../src/memory/reconsolidate.js';
import { assertFactCorePreserved } from '../src/ontology.js';
import { PARAMS } from '../src/params.js';

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

console.log('reconsolidate: 和好后旧怨随多次想起回暖, 但 fact_core 不变 (灵魂验收)');
{
  const FACT = '2024-03 我们因为我忘了纪念日吵了一架';
  let mem = { id: 'm1', fact_core: FACT, content: FACT, affect_valence: -0.9, affect_intensity: 0.9, narrative: '她当时很受伤', reconsolidation_count: 0 };

  // 和好后她心情回正
  const reconciled = { mood: { valence: 0.6, arousal: 0.3 } };

  const v0 = mem.affect_valence;
  // 模拟"反复想起" (每次 recall 命中都轻量重构)
  for (let i = 0; i < 12; i++) {
    [mem] = reconsolidate([mem], reconciled);
  }
  ok('多次想起后 affect_valence 明显回暖', mem.affect_valence > v0 + 0.2);
  ok('回暖不越过当下心情 (不失真为完全相反)', mem.affect_valence <= reconciled.mood.valence + 1e-9);
  ok('fact_core 一字未变 (红线)', mem.fact_core === FACT);
  ok('reconsolidation_count 累加', mem.reconsolidation_count === 12);
  ok('落库前红线守卫通过', assertFactCorePreserved({ fact_core: FACT }, mem) === true);
}

console.log('漂移有界 + 锁定记忆零漂移');
{
  const mem = { id: 'a', fact_core: 'x', affect_valence: 0, affect_intensity: 0 };
  const [one] = reconsolidate([mem], { mood: { valence: 1, arousal: 1 } }, { rate: 0.05 });
  ok('单次靠拢不超过 rate', Math.abs(one.affect_valence - 0) <= 0.05 + 1e-9);

  const clamp = PARAMS.reconsolidation.affectClamp;
  const [big] = reconsolidate([mem], { mood: { valence: 1, arousal: 1 } }, { rate: 999 });
  ok('rate 再大也被 affectClamp 夹住', Math.abs(big.affect_valence) <= clamp + 1e-9);

  // fact_locked: 生日/承诺这类硬事实, 情感层也冻结
  const locked = { id: 'b', fact_core: '生日 12-15', affect_valence: 0.2, affect_intensity: 0.3, fact_locked: true };
  const [lk] = reconsolidate([locked], { mood: { valence: -1, arousal: 1 } }, { rate: 0.15 });
  ok('fact_locked: valence 零漂移', lk.affect_valence === 0.2);
  ok('fact_locked: fact_core 不变', lk.fact_core === '生日 12-15');
}

console.log('narrative: 仅在提供时替换, 且永不污染 fact_core');
{
  const mem = { id: 'c', fact_core: '那天下雨', affect_valence: -0.5, affect_intensity: 0.5, narrative: '当时很狼狈' };
  const [noN] = reconsolidate([mem], { mood: { valence: 0.5, arousal: 0.3 } });
  ok('未提供 narrative 时保留旧解读', noN.narrative === '当时很狼狈');
  const [withN] = reconsolidate([mem], { mood: { valence: 0.5, arousal: 0.3 } }, { narratives: { c: '现在想想还挺浪漫' } });
  ok('提供 narrative 时被替换', withN.narrative === '现在想想还挺浪漫');
  ok('替换 narrative 后 fact_core 仍不变', withN.fact_core === '那天下雨');
}

console.log('shouldRewriteNarrative (情绪显著变化才值得调 LLM)');
{
  const mem = { affect_valence: -0.8 };
  ok('心情与记忆差异大 → 该重写', shouldRewriteNarrative(mem, { mood: { valence: 0.6 } }) === true);
  ok('心情与记忆接近 → 不必重写', shouldRewriteNarrative(mem, { mood: { valence: -0.7 } }) === false);
}

console.log('红线: 越权篡改 fact_core 必被 assertFactCorePreserved 抓住');
throws('重构后强行改 fact_core → 抛错', () => {
  const before = { fact_core: '真相' };
  const [after] = reconsolidate([{ id: 'z', fact_core: '真相', affect_valence: 0 }], { mood: { valence: 1 } });
  assertFactCorePreserved(before, { ...after, fact_core: '篡改后的事实' });
});

console.log(`\nM3 全部 ${passed} 条断言通过 ✅`);
