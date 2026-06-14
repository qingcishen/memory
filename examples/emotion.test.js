// Emotion 纯逻辑测试: 双层情绪 + 衰减 + 阻尼 + prompt/sampling。
import assert from 'node:assert';
import {
  defaultEmotion,
  clampEmotion,
  decayEmotionByHours,
  applyEmotionDeltas,
  inferEmotionDeltasHeuristic,
  toEmotionPrompt,
  emotionSamplingHints,
} from '../src/emotion.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('defaultEmotion / clampEmotion');
{
  const d = defaultEmotion();
  ok('默认 baseline valence=0.15', d.baseline.valence === 0.15);
  ok('默认 energy=0.5', d.energy === 0.5);
  const c = clampEmotion({ valence: 9, energy: -1, warmth: 2, baseline: { valence: -9 } });
  ok('valence 裁剪到 1', c.valence === 1);
  ok('energy 裁剪到 0', c.energy === 0);
  ok('warmth 裁剪到 1', c.warmth === 1);
  ok('baseline 同样裁剪', c.baseline.valence === -1);
}

console.log('decayEmotionByHours (回归基线而不是归零)');
{
  const s = clampEmotion({
    baseline: { valence: 0.15, energy: 0.5, warmth: 0.5 },
    halfLifeHours: { valence: 6, energy: 4, warmth: 6 },
    valence: 0.75,
    energy: 0.9,
    warmth: 0.2,
  });
  const atHalf = decayEmotionByHours(s, 6);
  ok('valence 半衰期后偏移减半', Math.abs(atHalf.valence - 0.45) < 1e-9);
  ok('energy 按自己的半衰期更快回落', atHalf.energy < 0.7);
  const longAfter = decayEmotionByHours(s, 1000);
  ok('久置后 valence 回到 baseline 附近', Math.abs(longAfter.valence - 0.15) < 0.01);
  ok('久置后 warmth 回到 baseline 附近', Math.abs(longAfter.warmth - 0.5) < 0.01);
}

console.log('applyEmotionDeltas (阻尼 + 单轮上限)');
{
  const base = defaultEmotion();
  const next = applyEmotionDeltas(base, { valence: 10, energy: 10, warmth: -10 }, { damping: 0.4, maxStepPerTurn: 0.25 });
  ok('valence 单轮最多推动 0.1', Math.abs(next.valence - (base.valence + 0.1)) < 1e-9);
  ok('energy 单轮最多推动 0.1', Math.abs(next.energy - (base.energy + 0.1)) < 1e-9);
  ok('warmth 单轮最多下降 0.1', Math.abs(next.warmth - (base.warmth - 0.1)) < 1e-9);
}

console.log('inferEmotionDeltasHeuristic');
{
  const warm = inferEmotionDeltasHeuristic('我好想你, 喜欢你', '我也在');
  ok('温情话语提升 valence', warm.valence > 0);
  ok('温情话语提升 warmth', warm.warmth > 0);
  const fight = inferEmotionDeltasHeuristic('你太让我失望了, 别理我', '我在听');
  ok('冲突话语降低 valence', fight.valence < 0);
  ok('冲突话语降低 warmth', fight.warmth < 0);
}

console.log('toEmotionPrompt / emotionSamplingHints');
{
  const low = clampEmotion({ valence: -0.4, energy: 0.2, warmth: 0.3 });
  const prompt = toEmotionPrompt(low);
  ok('低落 prompt 提醒少一点但不明说数值', prompt.includes('有点低落') && prompt.includes('别明说'));
  const hints = emotionSamplingHints(low);
  ok('低 energy 缩短 maxTokens', hints.maxTokens === 220);
  ok('temperature 随 energy 较低', hints.temperature < 0.85);

  const high = emotionSamplingHints(clampEmotion({ energy: 0.9 }));
  ok('高 energy 提高 temperature', high.temperature > hints.temperature);
  ok('高 energy 放宽 maxTokens', high.maxTokens === 650);
}

console.log(`\nEmotion 全部 ${passed} 条断言通过`);
