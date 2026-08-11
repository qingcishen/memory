#!/usr/bin/env node
// Model Fitness Evaluator CLI
// 用法: node --env-file=.env src/eval/index.js [options]
//
// 选项:
//   --model <name>          被测模型名称 (default: $REPLY_MODEL)
//   --api-key <key>         被测模型 API key (default: $REPLY_API_KEY/$LLM_API_KEY)
//   --base-url <url>        被测模型 base URL (default: $REPLY_BASE_URL/$LLM_BASE_URL)
//   --judge-model <name>    评分模型名称 (default: $LLM_MODEL)
//   --judge-api-key <key>   评分模型 API key
//   --judge-base-url <url>  评分模型 base URL
//   --phase <phase>         probe|score|sweep|persona|full (default: full)
//   --persona <id>          指定单个人设 id (gentle/lively/tsundere/intellectual)
//   --scenarios <list>      逗号分隔的场景子集 (default: all)
//   --concurrency <n>       并发数 (default: 5)
//   --temperature <n>       probe/score/persona 使用的 temperature (default: 0.78)
//   --top-p <n>             probe/score/persona 使用的 top_p (default: 0.95)
//   --no-verbose            静默输出

import { pathToFileURL } from 'node:url';
import { runProbe } from './runner.js';
import { scoreResults, aggregateScores } from './scorer.js';
import { sweepParams } from './paramSweep.js';
import { fitPersonality, loadPersonas } from './personalityFitter.js';
import { generateReport, printSummary } from './reporter.js';
import { SCENARIOS } from './testSuite.js';

export const EVAL_PHASES = Object.freeze(['probe', 'score', 'sweep', 'persona', 'full']);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

export function resolveEvalOptions(args, env = process.env) {
  const model = args.model ?? env.REPLY_MODEL ?? env.LLM_MODEL ?? 'deepseek-chat';
  const apiKey = args['api-key'] ?? env.REPLY_API_KEY ?? env.LLM_API_KEY;
  const baseURL = args['base-url'] ?? env.REPLY_BASE_URL ?? env.LLM_BASE_URL ?? 'https://api.deepseek.com';

  const judgeModel = args['judge-model'] ?? env.LLM_MODEL ?? 'deepseek-chat';
  const judgeApiKey = args['judge-api-key'] ?? env.LLM_API_KEY ?? apiKey;
  const judgeBaseURL = args['judge-base-url'] ?? env.LLM_BASE_URL ?? baseURL;

  const phase = String(args.phase ?? 'full').trim().toLowerCase();
  if (!EVAL_PHASES.includes(phase)) {
    throw new Error(`未知评测阶段: ${phase}（可选: ${EVAL_PHASES.join(', ')}）`);
  }

  const concurrency = Number.parseInt(args.concurrency ?? '5', 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error('--concurrency 必须是 1 到 20 的整数');
  }

  const scenarioFilter = args.scenarios
    ? String(args.scenarios).split(',').map((value) => value.trim()).filter(Boolean)
    : Object.keys(SCENARIOS);
  const unknownScenarios = scenarioFilter.filter((scenario) => !SCENARIOS[scenario]);
  if (unknownScenarios.length) {
    throw new Error(`未知评测场景: ${unknownScenarios.join(', ')}`);
  }
  if (!scenarioFilter.length) throw new Error('--scenarios 至少需要一个场景');

  return {
    model,
    apiKey,
    baseURL,
    judgeModel,
    judgeApiKey,
    judgeBaseURL,
    phase,
    verbose: args.verbose !== false && args['no-verbose'] !== true,
    concurrency,
    scenarioFilter,
    personaId: args.persona ?? null,
    defaultParams: {
      temperature: numberArg(args.temperature, 0.78, '--temperature', 2),
      top_p: numberArg(args['top-p'], 0.95, '--top-p', 1),
    },
  };
}

export function phasePlan(phase) {
  return {
    baseline: phase === 'score' || phase === 'full',
    sweep: phase === 'sweep' || phase === 'full',
    persona: phase === 'persona' || phase === 'full',
    finalReport: phase === 'score' || phase === 'persona' || phase === 'full',
  };
}

function numberArg(value, fallback, label, max) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${label} 必须是 0 到 ${max} 之间的数字`);
  }
  return parsed;
}

export async function runFitnessEvaluation(options, deps = {}) {
  const {
    runProbeFn = runProbe,
    scoreResultsFn = scoreResults,
    aggregateScoresFn = aggregateScores,
    sweepParamsFn = sweepParams,
    fitPersonalityFn = fitPersonality,
    loadPersonasFn = loadPersonas,
    generateReportFn = generateReport,
    printSummaryFn = printSummary,
    log = console.log,
  } = deps;

  const {
    model,
    apiKey,
    baseURL,
    judgeModel,
    judgeApiKey,
    judgeBaseURL,
    phase,
    verbose,
    concurrency,
    scenarioFilter,
    personaId,
    defaultParams,
  } = options;

  if (!apiKey) {
    throw new Error('需要 API key：--api-key 或 REPLY_API_KEY/LLM_API_KEY 环境变量');
  }

  const modelConfig = { model, apiKey, baseURL, maxConcurrency: concurrency, verbose };
  const judgeConfig = { model: judgeModel, apiKey: judgeApiKey, baseURL: judgeBaseURL, verbose };

  const allPersonas = loadPersonasFn();
  const defaultPersona = personaId
    ? allPersonas.find((persona) => persona.id === personaId)
    : allPersonas[0];
  if (!defaultPersona) {
    throw new Error(`找不到人设: ${personaId || '(默认)'}`);
  }

  log(`\n🔬 Model Fitness Evaluator`);
  log(`   被测模型: ${model} (${baseURL})`);
  log(`   评分模型: ${judgeModel}`);
  log(`   阶段: ${phase}`);

  if (phase === 'probe') {
    const { cacheFile } = await runProbeFn({
      ...modelConfig,
      persona: defaultPersona,
      params: defaultParams,
      scenarios: scenarioFilter,
    });
    log(`\n[probe] 结果写入: ${cacheFile}`);
    return { phase, cacheFile };
  }

  const plan = phasePlan(phase);
  let baseProbeResults = null;
  let probeLatency = {};
  let baseScores = null;
  let baseAgg = null;
  let topParams = [{ params: defaultParams }];
  let bestParams = defaultParams;
  let bestPersona = defaultPersona;
  let fitRanked = [];

  if (plan.baseline) {
    log('\n[baseline] Probe + Score — 跑基线并评分...');
    const baseline = await runProbeFn({
      ...modelConfig,
      persona: defaultPersona,
      params: defaultParams,
      scenarios: scenarioFilter,
    });
    baseProbeResults = selectProbeResults(
      baseline.results,
      defaultPersona.id,
      defaultParams,
    );
    probeLatency = latencyForProbeResults(baseProbeResults);
    baseScores = await scoreResultsFn(baseProbeResults, judgeConfig, SCENARIOS);
    baseAgg = aggregateScoresFn(baseScores);
    log(`  基线 overall: ${baseAgg.overall}/5`);
  }

  if (plan.sweep) {
    log('\n[sweep] 参数网格搜索...');
    const sweep = await sweepParamsFn(modelConfig, defaultPersona, judgeConfig);
    topParams = sweep.top5;
    bestParams = topParams[0]?.params ?? defaultParams;
    if (phase === 'sweep') {
      return { phase, ranked: sweep.ranked, top5: topParams };
    }
  }

  if (plan.persona) {
    log('\n[persona] 人设适配测试...');
    const fit = await fitPersonalityFn(modelConfig, topParams, judgeConfig, allPersonas);
    if (!fit.best) throw new Error('人设适配没有产生可用结果');
    bestParams = fit.best.params;
    bestPersona = allPersonas.find((persona) => persona.id === fit.best.persona.id) ?? defaultPersona;
    fitRanked = fit.ranked;
  }

  let finalScores = baseScores;
  let finalAgg = baseAgg;
  if (!plan.baseline || bestPersona.id !== defaultPersona.id || !sameParams(bestParams, defaultParams)) {
    log('\n[final] 最优配置最终评分...');
    const finalProbe = await runProbeFn({
      ...modelConfig,
      persona: bestPersona,
      params: bestParams,
      scenarios: scenarioFilter,
    });
    const selected = selectProbeResults(finalProbe.results, bestPersona.id, bestParams);
    finalScores = await scoreResultsFn(selected, judgeConfig, SCENARIOS);
    finalAgg = aggregateScoresFn(finalScores);
    probeLatency = latencyForProbeResults(selected);
  }

  if (!plan.finalReport || !finalAgg) {
    return { phase, bestParams, bestPersona, fitRanked };
  }

  const { report, outFile } = generateReportFn({
    model,
    probeLatency,
    scores: finalAgg,
    rawScores: finalScores,
    bestParams,
    bestPersona: { id: bestPersona.id, name: bestPersona.name },
    fitRanked,
  });
  printSummaryFn(report);
  log(`📄 报告已写入: ${outFile}`);
  return { phase, report, outFile };
}

export function selectProbeResults(results, personaId, params) {
  const suffix = `${personaId}:t${params.temperature}_p${params.top_p}`;
  return Object.fromEntries(
    Object.entries(results ?? {}).filter(([key]) => key.endsWith(suffix)),
  );
}

export function latencyForProbeResults(results) {
  const latencies = Object.values(results ?? {}).flatMap((result) => {
    if (Array.isArray(result?.turns)) {
      return result.turns.map((turn) => Number(turn?.latencyMs)).filter(Number.isFinite);
    }
    const latency = Number(result?.latencyMs);
    return Number.isFinite(latency) ? [latency] : [];
  }).sort((left, right) => left - right);
  return {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    count: latencies.length,
  };
}

function percentile(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * quantile) - 1);
  return sortedValues[index];
}

function sameParams(left, right) {
  return left?.temperature === right?.temperature && left?.top_p === right?.top_p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = resolveEvalOptions(args);

  await runFitnessEvaluation(options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error('[fatal]', err);
    process.exitCode = 1;
  });
}
