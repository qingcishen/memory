// StateLayer/Life 纯逻辑测试: emotion + life 统一状态层门面。不连网。
import assert from 'node:assert';
import { StateLayer } from '../src/state/stateLayer.js';
import { LifeDimension, clampLife, moodToLife, toLifePrompt, lifeSamplingHints } from '../src/state/life.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('clampLife / moodToLife');
{
  ok('energy 上界裁剪到 1', clampLife({ energy: 2 }).energy === 1);
  ok('energy 下界裁剪到 0', clampLife({ energy: -1 }).energy === 0);
  ok('缺 energy 补中值', clampLife({}).energy === 0.5);
  ok('mood.arousal 映射为 life.energy', moodToLife({ mood: { arousal: 0.2 } }).energy === 0.2);
  ok('moodToLife 只返回 energy', Object.keys(moodToLife({ mood: { arousal: 0.8 } })).join(',') === 'energy');
}

console.log('toLifePrompt / lifeSamplingHints');
{
  ok('空状态返回空串', toLifePrompt(null) === '');

  const lowPrompt = toLifePrompt({ energy: 0.2 });
  const lowHints = lifeSamplingHints({ energy: 0.2 });
  ok('低 energy prompt 提醒有些没精神', lowPrompt.includes('有些没精神'));
  ok('低 energy 缩短 maxTokens', lowHints.maxTokens === 220);
  ok('低 energy 降低 temperature', lowHints.temperature === 0.78);

  const midHints = lifeSamplingHints({ energy: 0.5 });
  ok('中等 energy 使用默认长度', midHints.maxTokens === 500);

  const highPrompt = toLifePrompt({ energy: 0.9 });
  const highHints = lifeSamplingHints({ energy: 0.9 });
  ok('高 energy prompt 提醒很有兴致', highPrompt.includes('很有兴致'));
  ok('高 energy 放宽 maxTokens', highHints.maxTokens === 650);
  ok('高 energy 提高 temperature', highHints.temperature === 1.06);
}

console.log('LifeDimension.current/evolve');
{
  const life = new LifeDimension({
    userId: 'u_life',
    read: async () => ({ mood: { arousal: 0.9 }, relationship: {}, updated_at: null }),
  });
  ok('life.current() 返回 {energy}', JSON.stringify(await life.current()) === JSON.stringify({ energy: 0.9 }));
  ok('life.evolve() 是 no-op 且不抛错', (await life.evolve([])) === undefined);

  const baseline = await new LifeDimension().current();
  ok('无 userId 时使用 M1 基线 arousal', baseline.energy === 0.3);

  const decayed = await new LifeDimension({
    userId: 'u_decay',
    now: () => new Date('2026-06-14T12:00:00Z').getTime(),
    read: async () => ({
      mood: { arousal: 0.9 },
      relationship: {},
      updated_at: '2026-06-14T08:00:00Z',
    }),
  }).current();
  ok('current() 会先按 updated_at 衰减 energy', decayed.energy > 0.3 && decayed.energy < 0.9);
}

console.log('StateLayer snapshot/toPrompt/samplingHints');
{
  const layer = new StateLayer({
    userId: 'u_state_layer',
    read: async () => ({
      mood: { valence: 0.8, arousal: 0.9 },
      relationship: { closeness: 0.5 },
      updated_at: null,
    }),
  });
  const snapshot = await layer.snapshot();
  ok('snapshot() 返回 emotion + life 两个维度', Object.keys(snapshot).sort().join(',') === 'emotion,life');
  ok('emotion 维度只有 valence/warmth', Object.keys(snapshot.emotion).sort().join(',') === 'valence,warmth');
  ok('life 维度返回 {energy}', JSON.stringify(snapshot.life) === JSON.stringify({ energy: 0.9 }));

  const prompt = layer.toPrompt(snapshot);
  ok('toPrompt() 拼接 emotion 指引', prompt.includes('心情不错'));
  ok('toPrompt() 拼接 life 指引', prompt.includes('很有兴致'));
  ok('samplingHints() 使用 life 维度', JSON.stringify(layer.samplingHints(snapshot)) === JSON.stringify({ temperature: 1.06, maxTokens: 650 }));
}

console.log(`\nStateLayer 全部 ${passed} 条断言通过`);
