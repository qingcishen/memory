import { describe, expect, test } from 'vitest';
import {
  BudgetExceededError, CostMeter, ablationConclusion, goldRank, judgeStability, requireEnv, ruleJudge,
} from '../bench/core.js';
import { runMemoryBench } from '../bench/run-memory-bench.js';
import { clampScore, renderTranscript, runDialogueEval } from '../bench/run-dialogue-eval.js';
import { ABLATION_FLAGS, buildReport } from '../bench/run-ablation.js';

// ---- E1 · 记忆基准编排逻辑 (假依赖, 零 DB/LLM) ----

function fakeDeps(overrides = {}) {
  const backdated = [];
  let nextId = 0;
  const deps = {
    userId: (item) => `bench_test_${item.id}`,
    makeMemory: (userId) => ({ userId }),
    // 每个 session 存 1 条记忆, id 递增; 内容 = 该 session 最后一句
    ingest: async (_mem, turns) => [{ id: `m${nextId++}`, content: turns.at(-1).content }],
    backdate: async (ids, iso) => backdated.push({ ids, iso }),
    // 检索永远命中最后灌入的那条排第 1
    recall: async () => [{ id: `m${nextId - 1}` }, { id: 'noise' }],
    format: (hits) => hits.map((h) => `- ${h.id}`).join('\n'),
    answer: async () => '答案',
    arbitrate: async () => false,
    now: () => Date.parse('2026-07-27T00:00:00Z'),
    _backdated: backdated,
    ...overrides,
  };
  return deps;
}

describe('E1 memory bench orchestration', () => {
  test('sessions are ingested oldest-first and backdated to daysAgo', async () => {
    const deps = fakeDeps();
    await runMemoryBench([{
      id: 'order', kind: 'fact', questions: ['q'],
      sessions: [{ daysAgo: 1, turns: [{ role: 'user', content: '新' }] }, { daysAgo: 30, turns: [{ role: 'user', content: '旧' }] }],
      expect: { mustMention: ['答案'] },
    }], deps);
    expect(deps._backdated).toHaveLength(2);
    expect(deps._backdated[0].iso).toBe('2026-06-27T00:00:00.000Z'); // 30 天前先灌
    expect(deps._backdated[1].iso).toBe('2026-07-26T00:00:00.000Z');
  });

  test('update cases treat only the newest session as gold', async () => {
    const deps = fakeDeps();
    const result = await runMemoryBench([{
      id: 'u', kind: 'update', questions: ['q'],
      sessions: [{ daysAgo: 40, turns: [{ role: 'user', content: '旧偏好' }] }, { daysAgo: 2, turns: [{ role: 'user', content: '新偏好' }] }],
      expect: { mustMention: ['答案'] },
    }], deps);
    expect(result.rows[0].goldCount).toBe(1); // 只有新偏好那条
    expect(result.rows[0].goldRank).toBe(1);
    expect(result.retrieval.recallAt5).toBe(1);
  });

  test('abstention rows and unstored cases are excluded from retrieval metrics', async () => {
    const deps = fakeDeps({ ingest: async () => [] }); // 什么都没存 -> goldCount 0
    const result = await runMemoryBench([{
      id: 'abs', kind: 'abstention', questions: ['q'], sessions: [{ daysAgo: 1, turns: [{ role: 'user', content: 'x' }] }],
      expect: { mustMention: ['不知道'] },
    }], deps);
    expect(result.retrieval.cases).toBe(0);
    expect(result.perKind.abstention.accuracy).toBe(0); // '答案' 不含 '不知道', 仲裁也 false
  });

  test('failed rule check falls through to judge arbitration', async () => {
    let arbitrated = 0;
    const deps = fakeDeps({ answer: async () => '这事你没说过, 我真不知道呀', arbitrate: async () => { arbitrated += 1; return true; } });
    const result = await runMemoryBench([{
      id: 'arb', kind: 'abstention', questions: ['q'], sessions: [],
      expect: { mustMention: ['不知道'] }, // 规则不中 ("不知道" 被 "真不知道呀" 包含 -> 其实中了; 换个词
    }], deps);
    // "我真不知道呀" 包含 "不知道", 规则直接判对, 不进仲裁
    expect(result.overall).toBe(1);
    expect(arbitrated).toBe(0);
    const deps2 = fakeDeps({ answer: async () => '这事你没提过哦', arbitrate: async () => { arbitrated += 1; return true; } });
    const result2 = await runMemoryBench([{
      id: 'arb2', kind: 'abstention', questions: ['q'], sessions: [], expect: { mustMention: ['不知道'] },
    }], deps2);
    expect(arbitrated).toBe(1);
    expect(result2.rows[0]).toMatchObject({ correct: true, arbitrated: true });
  });
});

// ---- E2 · 对话评测编排逻辑 ----

function fakeBotFactory(log = []) {
  return async (scenario) => ({
    replies: 0,
    async reply(message) {
      this.replies += 1;
      log.push(`${scenario.id}:${message}`);
      return { text: `回:${message}` };
    },
  });
}

describe('E2 dialogue eval orchestration', () => {
  const scenarios = [
    { id: 's1', focus: 'f1', turns: ['a', 'b'] },
    { id: 's2', turns: ['c'] },
  ];

  test('runs every turn through the bot and judges full transcripts', async () => {
    const log = [];
    const judged = [];
    const result = await runDialogueEval(scenarios, {
      makeBot: fakeBotFactory(log),
      judge: async (t) => {
        judged.push(t.id);
        return { memory_consistency: 4, persona_stability: 4, emotional_fitness: 4, naturalness: 4, no_breaking: 4 };
      },
    });
    expect(log).toEqual(['s1:a', 's1:b', 's2:c']);
    expect(judged).toEqual(['s1', 's2']);
    expect(result.overall).toBe(4);
    expect(result.transcripts[0].turns).toHaveLength(4);
    expect(result.transcripts[0].turns[1]).toEqual({ role: 'assistant', content: '回:a' });
    expect(result.stability).toBeNull();
  });

  test('clamps out-of-range judge scores and judgeTwice reports stability', async () => {
    let call = 0;
    const result = await runDialogueEval([{ id: 's', turns: ['x'] }], {
      makeBot: fakeBotFactory(),
      judgeTwice: true,
      judge: async () => {
        call += 1;
        return { memory_consistency: call === 1 ? 9 : 5, persona_stability: 0, emotional_fitness: 3, naturalness: 3, no_breaking: 3 };
      },
    });
    expect(result.scores[0].memory_consistency).toBe(5); // 9 -> clamp 5
    expect(result.scores[0].persona_stability).toBe(1);  // 0 -> clamp 1
    expect(result.stability.maxDelta).toBe(0);           // 两次都被 clamp 成一样
  });

  test('budget check aborts mid-run', async () => {
    const meter = new CostMeter({ budgetUsd: 0.01, pricing: { default: { inputPerMillion: 1e6, outputPerMillion: 0 } } });
    await expect(runDialogueEval([{ id: 's', turns: ['x', 'y'] }], {
      makeBot: async () => ({ reply: async () => { meter.addUsage('default', { prompt_tokens: 1 }); return { text: 'r' }; } }),
      judge: async () => ({}),
      checkBudget: () => meter.check(),
    })).rejects.toThrow(BudgetExceededError);
  });

  test('renderTranscript and clampScore helpers', () => {
    expect(renderTranscript([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toBe('用户: a\n她: b');
    expect(clampScore('4')).toBe(4);
    expect(clampScore('高')).toBeNull();
  });
});

// ---- 公共件 ----

describe('bench core helpers', () => {
  test('goldRank / ruleJudge / stability / conclusion', () => {
    expect(goldRank([{ id: 'a' }, { id: 'g' }], ['g'])).toBe(2);
    expect(goldRank([{ id: 'a' }], ['g'])).toBe(Infinity);
    expect(ruleJudge('喜欢香菜', { mustMention: ['香菜'], mustNotMention: ['讨厌'] })).toBe(true);
    const s = judgeStability(
      [{ memory_consistency: 4, persona_stability: 4, emotional_fitness: 4, naturalness: 4, no_breaking: 4 }],
      [{ memory_consistency: 3, persona_stability: 4, emotional_fitness: 4, naturalness: 4, no_breaking: 4 }],
    );
    expect(s.maxDelta).toBe(1);
    expect(ablationConclusion(0.3)).toBe('无法证明增益');
    expect(ablationConclusion(0.8)).toBe('保留');
    expect(ablationConclusion(-0.8)).toBe('有害,删除');
  });

  test('CostMeter tracks direct usage, metrics diff, and enforces budget', () => {
    const meter = new CostMeter({ budgetUsd: 1, pricing: { m: { inputPerMillion: 100, outputPerMillion: 200 }, default: { inputPerMillion: 50, outputPerMillion: 50 } } });
    meter.addUsage('m', { prompt_tokens: 1000, completion_tokens: 500 });
    expect(meter.totalUsd).toBeCloseTo((1000 * 100 + 500 * 200) / 1e6, 8);
    meter.settleMetricsDiff(
      { 'llm.prompt_tokens.extract': 100 },
      { 'llm.prompt_tokens.extract': 1100, 'llm.completion_tokens.extract': 200, 'llm.calls': 3 },
    );
    expect(meter.indirect).toBeCloseTo((1000 * 50 + 200 * 50) / 1e6, 8);
    const strict = new CostMeter({ budgetUsd: 0.0001, pricing: { default: { inputPerMillion: 1e6, outputPerMillion: 0 } } });
    expect(() => strict.addUsage('default', { prompt_tokens: 200 })).toThrow(BudgetExceededError);
    const forced = new CostMeter({ budgetUsd: 0.0001, force: true, pricing: { default: { inputPerMillion: 1e6, outputPerMillion: 0 } } });
    expect(() => forced.addUsage('default', { prompt_tokens: 200 })).not.toThrow();
  });

  test('requireEnv lists every missing variable', () => {
    expect(() => requireEnv(['A_MISSING', 'B_MISSING'], {})).toThrow(/A_MISSING, B_MISSING/);
    expect(() => requireEnv(['X'], { X: '1' })).not.toThrow();
  });
});

// ---- E3 · 消融报告 ----

describe('E3 ablation report', () => {
  test('covers all 7 mechanism flags', () => {
    expect(ABLATION_FLAGS).toEqual(['monologue', 'moodGating', 'reconsolidation', 'behaviorPolicy', 'narration', 'story', 'desire']);
  });

  test('buildReport puts unproven mechanisms on the removal list', () => {
    const rows = [
      { flag: 'monologue', overall: 3.1, delta: 0.9, costDeltaPerScenario: 0.001, conclusion: ablationConclusion(0.9) },
      { flag: 'story', overall: 3.9, delta: 0.1, costDeltaPerScenario: 0, conclusion: ablationConclusion(0.1) },
    ];
    const report = buildReport({ baseline: { overall: 4.0 }, rows });
    expect(report).toContain('| monologue | 4.00 | 3.10 | +0.90 |');
    expect(report).toContain('无法证明增益');
    expect(report).toContain('story');
    expect(report).not.toContain('无删除名单');
  });
});
