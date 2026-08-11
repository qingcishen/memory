import { describe, expect, it } from 'vitest';
import { PARAMS } from '../src/params.js';
import { intimacyTensionDesireBump } from '../src/existence/heartbeat.js';
import {
  consentCueNeeded,
  defaultIntimacy,
  evolveIntimacyOverTime,
  getAfterglowDelta,
  settleIntimacyFromTurns,
  toIntimacyPrompt,
} from '../src/state/intimacy.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const SAFE_CONTEXT = {
  relationship: {
    closeness: 0.9,
    trust: 0.85,
    tension: 0.05,
    repair_debt: 0,
  },
  life: { energy: 0.85, health: 0.95 },
};

describe('I-1 事后关系回暖', () => {
  it('aftercare_need 只要大于 0，一次回暖就达到固定关系增量', () => {
    const state = defaultIntimacy({
      scene_phase: 'cooldown',
      aftercare_need: 0.1,
      last_intimate_at: new Date(NOW - 60 * 60_000).toISOString(),
    });

    expect(getAfterglowDelta(state, NOW)).toMatchObject({
      relationship: {
        closeness: 0.04,
        tension: -0.06,
      },
    });
  });

  it('正常进入 aftercare 时挂起一次，下一轮 settle 后不重复结算', () => {
    const entered = settleIntimacyFromTurns(
      defaultIntimacy({
        scene_phase: 'peak',
        sexual_openness: 0.8,
        aftercare_need: 0.3,
        last_intimate_at: new Date(NOW - 10 * 60_000).toISOString(),
        consent: { active: true, pace: 'normal', stop_signal: false },
      }),
      [{ role: 'user', content: '做完了，休息吧' }],
      { ...SAFE_CONTEXT, sceneType: 'intimate', now: NOW },
    ).state;

    expect(entered.scene_phase).toBe('aftercare');
    expect(entered.afterglow_pending).toBe(true);
    expect(getAfterglowDelta(entered, NOW)?.relationship).toEqual({
      closeness: 0.04,
      tension: -0.06,
    });

    const consumed = settleIntimacyFromTurns(
      entered,
      [{ role: 'user', content: '早' }],
      { ...SAFE_CONTEXT, sceneType: 'daily', now: NOW + 60_000 },
    ).state;
    expect(consumed.afterglow_pending).toBe(false);
    // +0.04 余温不会重复；aftercare 刚完成时只剩独立的一次 +0.03。
    expect(getAfterglowDelta(consumed, NOW + 60_000)).toEqual({
      relationship: { closeness: 0.03 },
    });
    const fullySettled = settleIntimacyFromTurns(
      consumed,
      [{ role: 'user', content: '嗯' }],
      { ...SAFE_CONTEXT, sceneType: 'daily', now: NOW + 2 * 60_000 },
    ).state;
    expect(getAfterglowDelta(fullySettled, NOW + 2 * 60_000)).toBeNull();
  });

  it('明确 stop 产生的照料需求不会误算为正向回暖', () => {
    const stopped = settleIntimacyFromTurns(
      defaultIntimacy({
        scene_phase: 'peak',
        arousal: 0.8,
        aftercare_need: 0.2,
        consent: { active: true, pace: 'normal', stop_signal: false },
      }),
      [{ role: 'user', content: '停下，有点疼' }],
      { ...SAFE_CONTEXT, sceneType: 'intimate', now: NOW },
    ).state;

    expect(stopped.afterglow_pending).toBe(false);
    expect(getAfterglowDelta(stopped, NOW)).toBeNull();
  });

  it('aftercare 完成后 2h 内的下一轮对话额外增加 0.03 closeness，且只结算一次', () => {
    const completed = settleIntimacyFromTurns(
      defaultIntimacy({
        scene_phase: 'aftercare',
        aftercare_need: 0.2,
        afterglow_pending: false,
        last_intimate_at: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      [{ role: 'user', content: '我们聊点别的吧' }],
      { ...SAFE_CONTEXT, sceneType: 'daily', now: NOW },
    ).state;

    expect(completed.scene_phase).toBe('cooldown');
    expect(completed.aftercare_completion_pending).toBe(true);
    expect(getAfterglowDelta(completed, NOW + 60 * 60_000)).toEqual({
      relationship: { closeness: 0.03 },
    });

    const consumed = settleIntimacyFromTurns(
      completed,
      [{ role: 'user', content: '嗯' }],
      { ...SAFE_CONTEXT, sceneType: 'daily', now: NOW + 60 * 60_000 },
    ).state;
    expect(consumed.aftercare_completion_pending).toBe(false);
    expect(getAfterglowDelta(consumed, NOW + 61 * 60_000)).toBeNull();
    expect(getAfterglowDelta(completed, NOW + 2 * 60 * 60_000 + 1)).toBeNull();
  });
});

describe('I-2 跨天张力弧线', () => {
  it('默认高开放关系沉默 72h 后 sexual_tension 超过 0.6 且不越过弧线上限', () => {
    const grown = evolveIntimacyOverTime(
      defaultIntimacy({
        sexual_openness: 0.8,
        sexual_tension: 0,
        satisfaction: 0.55,
      }),
      72,
      PARAMS.intimacy,
    );

    expect(grown.sexual_tension).toBeGreaterThan(0.6);
    expect(grown.sexual_tension).toBeLessThanOrEqual(0.9);
  });

  it('heartbeat 欲望加成使用注入时钟，2 天内为零、3 天后启动', () => {
    const intimacy = {
      sexual_tension: 0.8,
      last_intimate_at: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString(),
    };

    expect(intimacyTensionDesireBump(intimacy, NOW)).toBeCloseTo(0.02, 8);
    expect(
      intimacyTensionDesireBump(
        intimacy,
        NOW - 2 * 24 * 60 * 60_000,
      ),
    ).toBe(0);
    expect(intimacyTensionDesireBump(intimacy, () => NOW)).toBeCloseTo(0.02, 8);
  });
});

describe('I-4 flirting → foreplay 自然同意节点', () => {
  const previous = defaultIntimacy({
    scene_phase: 'flirting',
    sexual_openness: 0.8,
  });
  const current = defaultIntimacy({
    scene_phase: 'foreplay',
    sexual_openness: 0.8,
    consent: { active: true, pace: 'normal', stop_signal: false },
  });

  it('仅转换轮触发；完整关系与身体门控失败时不触发', () => {
    expect(consentCueNeeded(previous, current, SAFE_CONTEXT, PARAMS.intimacy)).toBe(true);
    expect(consentCueNeeded(current, current, SAFE_CONTEXT, PARAMS.intimacy)).toBe(false);
    expect(
      consentCueNeeded(previous, current, {
        ...SAFE_CONTEXT,
        relationship: { ...SAFE_CONTEXT.relationship, trust: 0.1 },
      }, PARAMS.intimacy),
    ).toBe(false);
    expect(
      consentCueNeeded(previous, current, {
        ...SAFE_CONTEXT,
        life: { ...SAFE_CONTEXT.life, health: 0.2 },
      }, PARAMS.intimacy),
    ).toBe(false);
  });

  it('反应模糊时允许一句自然短问，不会在后续 foreplay 轮重复', () => {
    const ambiguous = toIntimacyPrompt(current, {
      ...SAFE_CONTEXT,
      prevIntimacy: previous,
      userMessage: '嗯……',
    });
    expect(ambiguous).toContain('【自然同意】');
    expect(ambiguous).toContain('自然短问');
    expect(ambiguous).toContain('想我继续吗');

    const nextRound = toIntimacyPrompt(current, {
      ...SAFE_CONTEXT,
      previousPhase: 'foreplay',
      userMessage: '嗯……',
    });
    expect(nextRound).not.toContain('【自然同意】');
  });

  it('清晰配合时读身体反应；退缩或 stop 时必须停住而非推进', () => {
    const positive = toIntimacyPrompt(current, {
      ...SAFE_CONTEXT,
      previousPhase: 'flirting',
      userMessage: '我回吻你，抱紧一点，继续',
    });
    expect(positive).toContain('【自然同意】');
    expect(positive).toContain('反应清楚才顺势继续');
    expect(positive).not.toContain('自然短问');

    const retreat = toIntimacyPrompt(current, {
      ...SAFE_CONTEXT,
      prevIntimacy: previous,
      userMessage: '等等，我有点不舒服，先停一下',
    });
    expect(consentCueNeeded(previous, current, {
      ...SAFE_CONTEXT,
      userMessage: '等等，我有点不舒服，先停一下',
    })).toBe(false);
    expect(retreat).toContain('立刻停住');
    expect(retreat).toContain('不得继续推进');
    expect(retreat).not.toContain('反应清楚才顺势继续');
    expect(retreat).not.toContain('前戏中');
  });

  it('低 trust 时 prompt 不再注入相互矛盾的推进提示', () => {
    const prompt = toIntimacyPrompt(current, {
      ...SAFE_CONTEXT,
      prevIntimacy: previous,
      relationship: { ...SAFE_CONTEXT.relationship, trust: 0.1 },
    });
    expect(prompt).not.toContain('【自然同意】');
    expect(prompt).not.toContain('前戏中');
    expect(prompt).toContain('不适合进入性爱正戏');
  });
});
