// 人设适配测试 — 用 top5 参数组合 × 4 套人设，找最优组合
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { runProbe } from './runner.js';
import { scoreResults, aggregateScores } from './scorer.js';
import { SCENARIOS } from './testSuite.js';

const PERSONAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'personas');

// 人设测试场景：情感相关的最能分辨风格差异
const FIT_SCENARIOS = ['affectionate', 'casual', 'stability'];

/** 从 personas/ 目录加载所有人设 JSON */
export function loadPersonas() {
  return readdirSync(PERSONAS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(PERSONAS_DIR, f), 'utf8')));
}

/**
 * 对每个人设 × top5 参数组合跑评分，找最优 (persona, params)。
 *
 * @param {object} modelConfig - { model, apiKey, baseURL }
 * @param {Array} top5Params - sweepParams() 返回的 top5
 * @param {object} judgeConfig - { model, apiKey, baseURL }
 * @param {Array} [personas] - 默认从 personas/ 目录加载
 * @returns {{ best: { persona, params, score }, ranked: Array }}
 */
export async function fitPersonality(modelConfig, top5Params, judgeConfig, personas) {
  const { verbose = true } = modelConfig;
  const allPersonas = personas ?? loadPersonas();

  if (verbose) {
    console.log(`\n[fit] ${allPersonas.length} 人设 × top ${top5Params.length} 参数组合`);
  }

  const results = [];

  for (const persona of allPersonas) {
    for (const { params, score: sweepScore } of top5Params) {
      if (verbose) console.log(`\n[fit] persona=${persona.name} t=${params.temperature} p=${params.top_p}`);

      const { results: allCached } = await runProbe({
        ...modelConfig,
        persona,
        params,
        scenarios: FIT_SCENARIOS,
        verbose,
      });

      const paramSuffix = `${persona.id}:t${params.temperature}_p${params.top_p}`;
      const probeResults = Object.fromEntries(
        Object.entries(allCached).filter(([k]) => k.endsWith(paramSuffix)),
      );

      const scores = await scoreResults(probeResults, judgeConfig, SCENARIOS);
      const agg = aggregateScores(scores);

      results.push({
        persona: { id: persona.id, name: persona.name },
        params,
        score: agg.overall,
        naturalness: agg.naturalness,
        consistency: agg.consistency,
        emotion: agg.emotion,
        sweepScore,
      });

      if (verbose) {
        console.log(`  → overall=${agg.overall} nat=${agg.naturalness} con=${agg.consistency}`);
      }
    }
  }

  const ranked = results.sort((a, b) => b.score - a.score);
  const best = ranked[0];

  if (verbose) {
    console.log('\n[fit] 排名前3:');
    ranked.slice(0, 3).forEach((r, i) => {
      console.log(
        `  #${i + 1} ${r.persona.name} | t=${r.params.temperature} p=${r.params.top_p} | score=${r.score}`,
      );
    });
    console.log(`\n[fit] 最优: ${best.persona.name} (t=${best.params.temperature} p=${best.params.top_p}) score=${best.score}`);
  }

  return { best, ranked };
}
