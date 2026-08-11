import { describe, expect, it } from 'vitest';
import {
  EMOTION_LABELS,
  emotionLabelToPrompt,
  inferEmotionLabelRaw,
} from '../src/state/emotionLabel.js';
import {
  NEGATIVE_EMOTION_LABELS,
  POSITIVE_EMOTION_LABELS,
  applyLabelInertia,
} from '../src/state/emotionResidue.js';

function infer({
  text = '普通的一天',
  valence = 0,
  closeness = 0.7,
  tension = 0,
  repairDebt = 0,
  desires = {},
} = {}) {
  return inferEmotionLabelRaw(
    {
      emotion: { valence, warmth: closeness },
      relationship: {
        closeness,
        tension,
        repair_debt: repairDebt,
      },
    },
    desires,
    [{ role: 'user', content: text }],
  );
}

describe('E-1 sixteen-label coverage', () => {
  const cases = [
    ['平静', { text: '今天就是普通的一天' }],
    ['开心', { text: '今天状态不错', valence: 0.45 }],
    ['委屈', { text: '你这几天都不回我' }],
    ['吃醋', { text: '新来的女同事今天又找你聊天了' }],
    ['生气', { text: '我很生气，你太过分了' }],
    ['失落', { text: '今天有点安静', valence: -0.25 }],
    ['撒娇', { text: '陪我一会儿嘛', desires: { comfort: 0.8 } }],
    ['心疼', { text: '我今天发烧了，很不舒服' }],
    ['期待', { text: '好期待周末和你一起去看电影' }],
    ['担心', { text: '我有点担心明天的面试会出问题' }],
    ['害羞', { text: '我好喜欢你，你真的很迷人' }],
    ['暧昧', { text: '靠得好近，心跳好像有点不一样' }],
    ['感动', { text: '谢谢你懂我，还记得我说过的那些细节' }],
    ['无聊', { text: '好无聊，完全不知道干嘛' }],
    ['骄傲', { text: '我做到了，终于拿到 offer 了' }],
    ['烦躁', { text: '一堆事乱七八糟，真的烦死了' }],
  ];

  it.each(cases)('%s has an observable deterministic rule', (label, input) => {
    expect(infer(input)).toBe(label);
  });

  it('keeps exactly 16 unique labels and prompt guidance for every non-neutral label', () => {
    expect(new Set(EMOTION_LABELS).size).toBe(16);
    expect(EMOTION_LABELS).toHaveLength(16);
    for (const label of EMOTION_LABELS.filter((item) => item !== '平静')) {
      expect(emotionLabelToPrompt(label), label).toContain('【情绪表现】');
    }
  });

  it('classifies all extended labels in residue polarity/stickiness behavior', () => {
    expect([...POSITIVE_EMOTION_LABELS]).toEqual(
      expect.arrayContaining(['期待', '害羞', '暧昧', '感动', '骄傲']),
    );
    expect([...NEGATIVE_EMOTION_LABELS]).toEqual(
      expect.arrayContaining(['担心', '烦躁']),
    );
    for (const label of EMOTION_LABELS) {
      const result = applyLabelInertia(null, label, {
        userMessage: '明确的新情绪',
        relationship: { tension: 0, repair_debt: 0 },
        now: 1,
      });
      expect(result.residual.label).toBe(label);
      expect(result.residual.intensity).toBeGreaterThan(0);
    }
  });
});
