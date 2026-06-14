// Emotion 纯逻辑测试: M1 状态 -> {valence, warmth} 映射 + prompt。
//
// 心情(valence/arousal)的衰减/更新已由 M1 (src/state/affect.js) 统一维护并测试
// (见 examples/state.test.js); 这里只测【映射 + 表现层】, 不重复测衰减/增量。
import assert from 'node:assert';
import {
  defaultEmotion,
  clampEmotion,
  moodToEmotion,
  toEmotionPrompt,
} from '../src/emotion.js';
import { defaultState } from '../src/state/affect.js';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  ✓', name);
  passed++;
};

console.log('clampEmotion (裁剪到合法范围, 缺字段补中值)');
{
  const c = clampEmotion({ valence: 9, warmth: 2 });
  ok('valence 裁剪到 1', c.valence === 1);
  ok('warmth 裁剪到 1', c.warmth === 1);
  const empty = clampEmotion({});
  ok('缺字段补中值 (valence)', empty.valence === 0);
  ok('缺字段补中值 (warmth)', empty.warmth === 0.5);
}

console.log('defaultEmotion (= moodToEmotion(defaultState()))');
{
  const d = defaultEmotion();
  const fromDefaultState = moodToEmotion(defaultState());
  ok('与 moodToEmotion(defaultState()) 一致', JSON.stringify(d) === JSON.stringify(fromDefaultState));
  ok('valence 取 M1 mood 基线 (0)', d.valence === 0);
  ok('warmth 取亲密度基线 (closeness=0.5)', Math.abs(d.warmth - 0.5) < 1e-9);
}

console.log('moodToEmotion (valence 直接来自 mood, warmth 随亲密度+心情/紧张调整)');
{
  const happy = moodToEmotion({ mood: { valence: 0.8, arousal: 0.6 }, relationship: { closeness: 0.5 } });
  ok('valence 直接对应 mood.valence', happy.valence === 0.8);
  ok('moodToEmotion 只返回 valence/warmth', Object.keys(happy).sort().join(',') === 'valence,warmth');
  ok('心情好时 warmth 在亲密度基线上升高', happy.warmth > 0.5);

  const tense = moodToEmotion({ mood: { valence: 0, arousal: 0.3 }, relationship: { closeness: 0.6, tension: 0.8, repair_debt: 0.5 } });
  ok('紧张/欠和好时 warmth 跌到亲密度基线以下', tense.warmth < 0.6);
  ok('即使关系熟(closeness高), 吵架这一刻也会"变冷"', tense.warmth < 0.35);

  const intimate = moodToEmotion({ mood: { valence: 1, arousal: 0.3 }, relationship: { closeness: 0.8 } });
  ok('高亲密 + 好心情 -> warmth 可以很高', intimate.warmth > 0.72);
}

console.log('toEmotionPrompt');
{
  ok('空状态返回空串', toEmotionPrompt(null) === '');

  const low = clampEmotion({ valence: -0.4, warmth: 0.3 });
  const prompt = toEmotionPrompt(low);
  ok('低落 prompt 提醒少一点但不明说数值', prompt.includes('有点低落') && prompt.includes('别明说'));
  ok('低 warmth -> 对对方稍微收着', prompt.includes('收着'));

  const high = clampEmotion({ valence: 0.6, warmth: 0.8 });
  const highPrompt = toEmotionPrompt(high);
  ok('开心 prompt', highPrompt.includes('心情不错'));
  ok('高 warmth -> 语气更柔软亲近', highPrompt.includes('柔软亲近'));
  ok('情绪 prompt 不再描述 energy', !highPrompt.includes('兴致') && !highPrompt.includes('精神') && !highPrompt.includes('状态一般'));
}

console.log(`\nEmotion 全部 ${passed} 条断言通过`);
