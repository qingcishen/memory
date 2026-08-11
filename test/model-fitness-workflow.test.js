import { describe, expect, it, vi } from 'vitest';
import {
  latencyForProbeResults,
  phasePlan,
  resolveEvalOptions,
  runFitnessEvaluation,
  selectProbeResults,
} from '../src/eval/index.js';

const personas = [
  { id: 'gentle', name: '温柔', systemPrompt: 'gentle' },
  { id: 'lively', name: '活泼', systemPrompt: 'lively' },
];

function options(phase) {
  return resolveEvalOptions(
    { phase, model: 'fixture', 'api-key': 'test-key', 'no-verbose': true },
    {},
  );
}

function deps() {
  const result = {
    'casual:c1:gentle:t0.78_p0.95': {
      response: '在呢',
      scenarioType: 'casual',
      promptId: 'c1',
    },
  };
  return {
    runProbeFn: vi.fn(async () => ({
      cacheFile: '/tmp/probe.json',
      results: result,
      latency: { p50: 10, p95: 20 },
    })),
    scoreResultsFn: vi.fn(async () => ({ one: { type: 'casual', naturalness: 4 } })),
    aggregateScoresFn: vi.fn(() => ({
      overall: 4,
      naturalness: 4,
      consistency: 4,
      length: 4,
      emotion: 4,
      memory_use_rate: null,
      boundary_refusal_threshold: null,
      scenario: { casual: 4 },
    })),
    sweepParamsFn: vi.fn(async () => ({
      ranked: [{ params: { temperature: 0.8, top_p: 0.9 }, score: 4 }],
      top5: [{ params: { temperature: 0.8, top_p: 0.9 }, score: 4 }],
    })),
    fitPersonalityFn: vi.fn(async (_model, topParams) => ({
      best: { persona: personas[1], params: topParams[0].params, score: 4 },
      ranked: [],
    })),
    loadPersonasFn: vi.fn(() => personas),
    generateReportFn: vi.fn((data) => ({ report: data, outFile: '/tmp/report.json' })),
    printSummaryFn: vi.fn(),
    log: vi.fn(),
  };
}

describe('model fitness workflow', () => {
  it('validates phase, scenario, concurrency and persona inputs', async () => {
    expect(() => resolveEvalOptions({ phase: 'unknown' }, {})).toThrow('未知评测阶段');
    expect(() => resolveEvalOptions({ scenarios: 'casual,missing' }, {})).toThrow('未知评测场景');
    expect(() => resolveEvalOptions({ concurrency: '0' }, {})).toThrow('--concurrency');
    expect(() => resolveEvalOptions({ 'top-p': '1.1' }, {})).toThrow('--top-p');

    const d = deps();
    await expect(
      runFitnessEvaluation({ ...options('probe'), personaId: 'missing' }, d),
    ).rejects.toThrow('找不到人设');
  });

  it('keeps sweep and persona as independent paid phases', async () => {
    expect(phasePlan('sweep')).toEqual({
      baseline: false,
      sweep: true,
      persona: false,
      finalReport: false,
    });
    const sweepDeps = deps();
    await runFitnessEvaluation(options('sweep'), sweepDeps);
    expect(sweepDeps.sweepParamsFn).toHaveBeenCalledOnce();
    expect(sweepDeps.fitPersonalityFn).not.toHaveBeenCalled();
    expect(sweepDeps.runProbeFn).not.toHaveBeenCalled();

    const personaDeps = deps();
    await runFitnessEvaluation(options('persona'), personaDeps);
    expect(personaDeps.sweepParamsFn).not.toHaveBeenCalled();
    expect(personaDeps.fitPersonalityFn).toHaveBeenCalledOnce();
    expect(personaDeps.runProbeFn).toHaveBeenCalledOnce();
  });

  it('scores the baseline once without duplicating model or judge calls', async () => {
    const d = deps();
    const result = await runFitnessEvaluation(options('score'), d);

    expect(result.report.scores.overall).toBe(4);
    expect(d.runProbeFn).toHaveBeenCalledOnce();
    expect(d.scoreResultsFn).toHaveBeenCalledOnce();
    expect(d.sweepParamsFn).not.toHaveBeenCalled();
    expect(d.fitPersonalityFn).not.toHaveBeenCalled();
  });

  it('filters a shared daily cache to the active persona and parameter pair', () => {
    const selected = selectProbeResults({
      'casual:c1:gentle:t0.78_p0.95': { response: 'a' },
      'casual:c1:lively:t0.78_p0.95': { response: 'b' },
      'casual:c1:gentle:t0.8_p0.9': { response: 'c' },
    }, 'gentle', { temperature: 0.78, top_p: 0.95 });

    expect(Object.keys(selected)).toEqual(['casual:c1:gentle:t0.78_p0.95']);
  });

  it('computes report latency from only the selected probe, including stability turns', () => {
    expect(latencyForProbeResults({
      one: { latencyMs: 10 },
      stability: { turns: [{ latencyMs: 20 }, { latencyMs: 100 }] },
    })).toEqual({ p50: 20, p95: 100, count: 3 });
  });
});
