import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const configs = [
  { id: 'heuristic-vector', args: ['--reranker=heuristic'] },
  { id: 'heuristic-hybrid', args: ['--reranker=heuristic', '--hybrid'] },
  { id: 'llm-hybrid', args: ['--reranker=llm', '--hybrid'] },
  { id: 'activation-hybrid', args: ['--reranker=activation', '--hybrid'] },
];
const force = process.argv.includes('--force');
const totalBudget = Number(process.env.BENCH_BUDGET_USD || 5);
const rows = [];

for (const config of configs) {
  const env = { ...process.env, BENCH_BUDGET_USD: String(totalBudget / configs.length) };
  const run = spawnSync(process.execPath, [path.resolve('bench/run-memory-bench.js'), ...config.args, ...(force ? ['--force'] : [])], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) process.exit(run.status || 1);
  const file = `${new Date().toISOString().slice(0, 10)}-memory-${config.args[0].split('=')[1]}${config.args.includes('--hybrid') ? '-hybrid' : ''}.json`;
  const result = JSON.parse(fs.readFileSync(path.resolve('bench/results', file), 'utf8'));
  rows.push({
    id: config.id,
    overall: result.overall,
    recallAt5: result.retrieval.recallAt5,
    recallAt10: result.retrieval.recallAt10,
    mrr: result.retrieval.mrr,
    p95LatencyMs: result.retrieval.p95LatencyMs,
    avgRerankCostUsd: result.retrieval.avgRerankCostUsd,
    totalCostUsd: result.costUsd,
  });
}

const vector = rows.find((row) => row.id === 'heuristic-vector');
const hybrid = rows.find((row) => row.id === 'heuristic-hybrid');
const llm = rows.find((row) => row.id === 'llm-hybrid');
const decision = {
  hybridRecallNonDecreasing: hybrid.recallAt5 >= vector.recallAt5,
  hybridP95IncreaseMs: hybrid.p95LatencyMs - vector.p95LatencyMs,
  hybridLatencyWithin150Ms: hybrid.p95LatencyMs - vector.p95LatencyMs <= 150,
  llmMrrImproved: llm.mrr > hybrid.mrr,
  llmCostWithinLimit: llm.avgRerankCostUsd <= 0.001,
  recommended: [...rows].sort((a, b) => b.mrr - a.mrr || b.overall - a.overall)[0].id,
};
const output = { ts: new Date().toISOString(), mode: 'live', rows, decision };
const file = path.resolve(`bench/results/${output.ts.slice(0, 10)}-retrieval-comparison.json`);
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
fs.appendFileSync(path.resolve('docs/bench-history.md'), [
  '',
  `### ${output.ts.slice(0, 10)} 检索四方实测`,
  '',
  '| 配置 | Overall | Recall@5 | Recall@10 | MRR | P95 ms | rerank $/query |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...rows.map((row) => `| ${row.id} | ${row.overall.toFixed(3)} | ${row.recallAt5.toFixed(3)} | ${row.recallAt10.toFixed(3)} | ${row.mrr.toFixed(3)} | ${row.p95LatencyMs.toFixed(1)} | ${row.avgRerankCostUsd.toFixed(6)} |`),
  '',
  `机械结论：推荐 ${decision.recommended}；hybrid Recall@5 不降=${decision.hybridRecallNonDecreasing}，P95 增幅 ${decision.hybridP95IncreaseMs.toFixed(1)}ms，LLM MRR 提升=${decision.llmMrrImproved}，LLM 单查询成本达标=${decision.llmCostWithinLimit}。`,
  '',
].join('\n'));
console.log(JSON.stringify(output, null, 2));
