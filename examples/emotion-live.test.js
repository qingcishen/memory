// Emotion Live Loop：desire bridge / 非对称衰减 / journal / proactive / story seed
import assert from 'node:assert';
import { residueToDesireEvent } from '../src/state/emotionDesireBridge.js';
import {
  emptyEmotionJournal,
  appendEmotionEvent,
  shouldLogEmotionTransition,
  emotionJournalToPrompt,
} from '../src/state/emotionJournal.js';
import { seedResidueFromStoryBeat, emptyEmotionResidue } from '../src/state/emotionResidue.js';
import { decayState, defaultState, applyDeltas } from '../src/state/affect.js';
import { buildProactiveContentPack } from '../src/companion/proactiveContent.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('L1 desire bridge');
{
  const e = residueToDesireEvent({ label: '委屈', intensity: 0.65 });
  ok('委屈→comfort', e && e.comfort > 0);
  ok('委屈→security', e.security > 0);
  ok('低强度不桥', residueToDesireEvent({ label: '委屈', intensity: 0.1 }) == null);
  ok('平静不桥', residueToDesireEvent({ label: '平静', intensity: 0.9 }) == null);
  const angry = residueToDesireEvent({ label: '生气', intensity: 0.7 });
  ok('生气→security', angry && angry.security > 0);
}

console.log('L2 asymmetric decay');
{
  const deep = applyDeltas(defaultState(), { mood: { valence: -0.7 } });
  const mild = applyDeltas(defaultState(), { mood: { valence: -0.2 } });
  const deepAfter = decayState(deep, 6);
  const mildAfter = decayState(mild, 6);
  // 大负向回落更慢 → 6h 后仍更负（距 0 更远）
  ok('大伤余味更长', Math.abs(deepAfter.mood.valence) > Math.abs(mildAfter.mood.valence));
  const pos = applyDeltas(defaultState(), { mood: { valence: 0.7 } });
  const posAfter = decayState(pos, 6);
  ok('正向会回落', posAfter.mood.valence < 0.7);
}

console.log('L3 journal');
{
  let j = emptyEmotionJournal();
  ok('应记切换', shouldLogEmotionTransition('平静', '委屈', 0.2, 0.6));
  j = appendEmotionEvent(j, { fromLabel: '平静', toLabel: '委屈', intensity: 0.6, cause: '冷落', source: 'turn' });
  j = appendEmotionEvent(j, { fromLabel: '委屈', toLabel: '委屈', intensity: 0.9, cause: '又被敷衍', source: 'turn' });
  ok('有事件', j.length >= 1);
  const p = emotionJournalToPrompt(j);
  ok('余波 prompt', p.includes('【情绪余波】') && !p.includes('0.6'));
}

console.log('L4 proactive emotion');
{
  const calm = buildProactiveContentPack({
    silenceTier: { tier: 'miss', hours: 8, reason: '对方已经 8 小时没说话' },
    emotionLabel: '平静',
    emotionResidue: { label: '平静', intensity: 0.2 },
  });
  const hurt = buildProactiveContentPack({
    silenceTier: { tier: 'miss', hours: 8, reason: '对方已经 8 小时没说话' },
    emotionLabel: '委屈',
    emotionResidue: { label: '委屈', intensity: 0.7 },
  });
  ok('委屈沉默 reason 不同', hurt.reason !== calm.reason && hurt.reason.includes('委屈'));
  ok('style 带别扭', hurt.style.includes('别扭') || hurt.style.includes('闷'));
  ok('emotion 源可选中', hurt.sources.some((s) => s.kind === 'emotion' || s.kind === 'silence'));
}

console.log('L5 story seed');
{
  const { residual, changed, event } = seedResidueFromStoryBeat(emptyEmotionResidue(), {
    mood_link: -0.5,
    content: '项目黄了',
  });
  ok('负向 beat→失落', changed && residual.label === '失落');
  ok('story event', event?.source === 'story');
  const held = seedResidueFromStoryBeat(
    { label: '生气', intensity: 0.7, turnsHeld: 2, stickyTurnsLeft: 3, updatedAt: Date.now() },
    { mood_link: -0.5, content: '又黄了' },
  );
  ok('不盖过强生气', held.changed === false && held.residual.label === '生气');
}

console.log(`\nemotion-live 全部 ${passed} 条断言通过 ✅`);
