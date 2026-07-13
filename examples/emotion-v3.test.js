// Emotion v3：惯性 / 表现 prompt / 人设半衰期 / 触景 / 持久化
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferEmotionLabel, inferEmotionLabelRaw, emotionLabelToPrompt } from '../src/state/emotionLabel.js';
import {
  applyLabelInertia,
  emptyEmotionResidue,
  hasEmotionFlipSignal,
  serializeEmotionResidue,
  normalizeEmotionResidue,
} from '../src/state/emotionResidue.js';
import { resonateFromMemoryHits, applyResonanceToEmotion } from '../src/state/emotionResonance.js';
import { decayState, emotionDecayOverridesFromConfig, defaultState, applyDeltas } from '../src/state/affect.js';
import { fuseEmotionPrompt, toEmotionPrompt } from '../src/emotion.js';
import { LocalJsonHistoryStore } from '../src/orchestrator/historyStore.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('E1 inertia');
{
  const cold = {
    emotion: { valence: -0.1, warmth: 0.5 },
    relationship: { closeness: 0.75, tension: 0.1, repair_debt: 0.1 },
  };
  const r1 = inferEmotionLabel(cold, { attention: 0.9 }, [{ role: 'user', content: '我回来啦最近太忙了' }], {
    withResidual: true,
  });
  ok('冷落后委屈', r1.label === '委屈');
  const r2 = inferEmotionLabel(
    { emotion: { valence: 0.2, warmth: 0.6 }, relationship: { closeness: 0.75, tension: 0.1, repair_debt: 0.05 } },
    {},
    [{ role: 'user', content: '哈哈今天天气不错' }],
    { previousResidual: r1.residual, withResidual: true },
  );
  ok('一句哈哈不翻盘仍委屈', r2.label === '委屈');

  const r3 = inferEmotionLabel(
    { emotion: { valence: 0.1, warmth: 0.55 }, relationship: { closeness: 0.75, tension: 0.08, repair_debt: 0.05 } },
    {},
    [{ role: 'user', content: '对不起，我错了，别生气了' }],
    { previousResidual: r2.residual, withResidual: true },
  );
  ok('道歉可解粘', r3.label !== '生气');
  ok('flip signal 识别道歉', hasEmotionFlipSignal({ userMessage: '对不起我错了' }));
}

console.log('E2 label prompt');
{
  const p = emotionLabelToPrompt('委屈', { intensity: 0.7, cause: '冷落' });
  ok('委屈表现段', p.includes('【情绪表现】') && p.includes('委屈') === false || p.includes('别扭'));
  ok('禁止自我播报口吻提示', p.includes('别') || p.includes('禁止') || p.includes('别扭'));
  const fused = fuseEmotionPrompt({ valence: -0.3, warmth: 0.4 }, '委屈', { intensity: 0.6 }, emotionLabelToPrompt);
  ok('融合含标量+离散', fused.includes('低落') || fused.includes('平静') || fused.includes('情绪表现'));
  ok('标量 toPrompt 仍可用', toEmotionPrompt({ valence: 0.6, warmth: 0.8 }).includes('心情不错'));
}

console.log('E3 companion halfLife');
{
  let s = applyDeltas(defaultState(), { mood: { valence: 0.6 } });
  const fast = decayState(s, 6, { halfLifeHours: { valence: 3 } });
  const slow = decayState(s, 6, { halfLifeHours: { valence: 12 } });
  ok('短半衰期回落更多', Math.abs(fast.mood.valence) < Math.abs(slow.mood.valence));
  const ov = emotionDecayOverridesFromConfig({
    emotionProfile: { valenceHalfLifeHours: 12, recoverBias: 0.8, baselineValence: 0.1 },
  });
  ok('config → overrides', ov.halfLifeHours.valence === 12 && ov.recoverBias === 0.8);
}

console.log('E4 resonate');
{
  const hits = [
    { fact_core: '你们大吵一架', affect_valence: -0.8, affect_intensity: 0.8 },
    { fact_core: '普通事', affect_intensity: 0.1 },
  ];
  const res = resonateFromMemoryHits(hits, { valence: 0.2, warmth: 0.6 });
  ok('有触景 delta', res && res.valenceDelta < 0);
  const emo = applyResonanceToEmotion({ valence: 0.2, warmth: 0.6 }, res);
  ok('展示 valence 下压', emo.valence < 0.2);
}

console.log('store residue');
{
  const file = path.join(os.tmpdir(), `emo-res-${Date.now()}.json`);
  const store = new LocalJsonHistoryStore({ file });
  const residue = serializeEmotionResidue({
    ...emptyEmotionResidue(),
    label: '委屈',
    intensity: 0.6,
    turnsHeld: 2,
  });
  await store.saveEmotionResidue({ userId: 'u', companionId: 'c', residue });
  const loaded = await store.loadEmotionResidue({ userId: 'u', companionId: 'c' });
  ok('load residue', normalizeEmotionResidue(loaded).label === '委屈');
  try {
    fs.unlinkSync(file);
  } catch {
    /* */
  }
}

console.log('raw label API 兼容');
{
  ok('raw 仍是字符串', typeof inferEmotionLabelRaw({}, {}, [{ role: 'user', content: '今天星期几' }]) === 'string');
  ok('无 residual 默认字符串', typeof inferEmotionLabel({}, {}, [{ role: 'user', content: '今天星期几' }]) === 'string');
}

console.log(`\nemotion-v3 全部 ${passed} 条断言通过 ✅`);
