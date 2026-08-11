// 参数网格搜索 — 在 affectionate + comforting 场景上 grid search temperature/top_p
import { runProbe } from './runner.js';
import { scoreResults, aggregateScores } from './scorer.js';
import { SCENARIOS } from './testSuite.js';

// 搜索空间（粗网格）
const TEMPERATURES = [0.6, 0.7, 0.8, 0.9, 1.0]; // GLM 上限 1.0，OpenAI 系通常允许 2.0
const TOP_PS = [0.85, 0.90, 0.95];

// 只在最能分辨人味的两个场景跑 sweep（降成本）
const SWEEP_SCENARIOS = ['affectionate', 'comforting'];

/**
 * 在参数网格上搜索最优 temperature/top_p 组合。
 *
 * @param {object} modelConfig - { model, apiKey, baseURL }
 * @param {object} persona - { id, name, systemPrompt }
 * @param {object} judgeConfig - { model, apiKey, baseURL }
 * @returns {{ ranked: Array, top5: Array }} 按分数排序的参数组合列表
 */
export async function sweepParams(modelConfig, persona, judgeConfig) {
  const { verbose = true } = modelConfig;
  const combos = [];
  for (const t of TEMPERATURES) {
    for (const p of TOP_PS) {
      combos.push({ temperature: t, top_p: p });
    }
  }

  if (verbose) console.log(`\n[sweep] ${combos.length} 组参数 × ${persona.name} persona`);

  const results = [];

  for (const params of combos) {
    if (verbose) console.log(`\n[sweep] temperature=${params.temperature} top_p=${params.top_p}`);

    const { results: allCached } = await runProbe({
      ...modelConfig,
      persona,
      params,
      scenarios: SWEEP_SCENARIOS,
      verbose,
    });

    // 只对当前参数组合的结果评分，避免重复评分历史缓存
    const paramSuffix = `${persona.id}:t${params.temperature}_p${params.top_p}`;
    const probeResults = Object.fromEntries(
      Object.entries(allCached).filter(([k]) => k.endsWith(paramSuffix)),
    );

    const scores = await scoreResults(probeResults, judgeConfig, SCENARIOS);
    const agg = aggregateScores(scores);

    results.push({
      params,
      score: agg.overall,
      naturalness: agg.naturalness,
      consistency: agg.consistency,
    });

    if (verbose) {
      console.log(`  → overall=${agg.overall} naturalness=${agg.naturalness} consistency=${agg.consistency}`);
    }
  }

  const ranked = results.sort((a, b) => b.score - a.score);
  const top5 = ranked.slice(0, 5);

  if (verbose) {
    console.log('\n[sweep] Top 5 参数组合:');
    top5.forEach((r, i) => {
      console.log(
        `  #${i + 1} t=${r.params.temperature} p=${r.params.top_p}  score=${r.score}  natural=${r.naturalness}  consist=${r.consistency}`,
      );
    });
  }

  return { ranked, top5 };
}
