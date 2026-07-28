// E3 · 消融实验: 同一批剧本 × (全开基线 + 逐一关闭 7 个机制), 全部走真实 E2 管线。
//
// 运行: npm run bench:ablation [-- --flags monologue,story] [-- --force]
// 成本 ≈ 8 × 一次 eval:dialogue; 预算由 BENCH_BUDGET_USD (默认 $5) 兜底, 超了立刻停。
// 结论规则是机械的: |Δ| ≤ judge 噪声(0.5) → 无法证明增益, 进删除/重构名单; 文档红线: 不许"再观察观察"。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BudgetExceededError, CostMeter, ablationConclusion, requireEnv } from './core.js';
import { liveDeps, loadScenarios, runDialogueEval } from './run-dialogue-eval.js';

export const ABLATION_FLAGS = ['monologue', 'moodGating', 'reconsolidation', 'behaviorPolicy', 'narration', 'story', 'desire'];
// 可独立测试但不进默认 E3 的机制
const EXTRA_FLAGS = ['evidenceBudget', 'utilityDecision', 'narrationPrompt', 'narrationClassifier', 'desirePrompt', 'desireInference'];
const NOISE = 0.5;

export function buildReport({ baseline, rows, noise = NOISE, note = '' }) {
  const harmful = rows.filter((row) => row.conclusion === '有害,删除').map((row) => row.flag);
  const unproven = rows.filter((row) => row.conclusion === '无法证明增益').map((row) => row.flag);
  const lines = [
    '# v3 消融报告',
    '',
    `> 真实管线 + LLM judge。基线 (全开) overall = ${baseline.overall.toFixed(2)}/5, judge 噪声阈值 ±${noise}。${note}`,
    '',
    '| 机制 | 开启分(基线) | 关闭分 | Δ | 每剧本成本差 | 结论 |',
    '|---|---:|---:|---:|---:|---|',
    ...rows.map((row) => `| ${row.flag} | ${baseline.overall.toFixed(2)} | ${row.overall.toFixed(2)} | ${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)} | $${row.costDeltaPerScenario.toFixed(4)} | ${row.conclusion} |`),
    '',
  ];
  if (harmful.length) lines.push(`**立即删除** (关闭后分数显著提升 > ${noise}): ${harmful.join(', ')}。`);
  if (unproven.length) lines.push(`**无法证明增益** (|Δ| ≤ ${noise}): ${unproven.join(', ')}。按 v3 红线, 保留唯一途径是补充能证明其价值的剧本进 E2 后重跑。`);
  if (!harmful.length && !unproven.length) lines.push('全部机制的增益均超过噪声阈值, 无删除名单。');
  lines.push('');
  return lines.join('\n');
}

export async function main() {
  if (process.argv.includes('--smoke')) {
    const scenarios = loadScenarios();
    const rows = ABLATION_FLAGS.map((flag) => ({ flag, wired: true }));
    console.log(JSON.stringify({ mode: 'smoke-schema-only', evidence: false, scenarios: scenarios.length, mechanisms: rows }, null, 2));
    return { rows };
  }
  requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'LLM_API_KEY', 'JUDGE_API_KEY', 'JUDGE_BASE_URL', 'JUDGE_MODEL']);
  const force = process.argv.includes('--force');
  const flagsArg = process.argv.find((a) => a.startsWith('--flags'));
  const allKnownFlags = [...ABLATION_FLAGS, ...EXTRA_FLAGS];
  const flags = flagsArg
    ? (flagsArg.split('=')[1] ?? process.argv[process.argv.indexOf(flagsArg) + 1] ?? '').split(',').filter((f) => allKnownFlags.includes(f))
    : ABLATION_FLAGS;
  const { metricsSnapshot } = await import('../src/metrics.js');
  const { PARAMS } = await import('../src/params.js');
  const meter = new CostMeter({
    budgetUsd: Number(process.env.BENCH_BUDGET_USD) || 5,
    force,
    pricing: PARAMS.trace?.pricing ?? {},
  });
  const scenarios = loadScenarios();
  const turns = scenarios.reduce((n, scenario) => n + scenario.turns.length, 0);
  const estimatedCalls = (turns + scenarios.length) * (flags.length + 1);
  const estimatedUsd = meter.price('default', estimatedCalls * 1800, estimatedCalls * 350);
  console.error(`[bench:ablation] 启动前预估上限 $${estimatedUsd.toFixed(4)}`);
  if (!force && estimatedUsd > meter.budgetUsd) throw new BudgetExceededError(estimatedUsd, meter.budgetUsd);
  console.error(`[bench:ablation] ${scenarios.length} 剧本 × (基线 + ${flags.length} 个机制), 预算 $${meter.budgetUsd}`);

  const runOnce = async (label, ablation) => {
    const runTag = `${Date.now().toString(36)}_${label}`;
    const before = metricsSnapshot();
    const costBefore = meter.totalUsd;
    const deps = await liveDeps({ runTag, meter, ablation });
    console.error(`[bench:ablation] === ${label} 开始 ===`);
    const result = await runDialogueEval(scenarios, { ...deps, label });
    meter.settleMetricsDiff(before, metricsSnapshot());
    return { ...result, runCostUsd: meter.totalUsd - costBefore };
  };

  try {
    const baseline = await runOnce('base', null);
    const rows = [];
    for (const flag of flags) {
      const off = await runOnce(`no_${flag}`, { [flag]: false });
      const delta = baseline.overall - off.overall; // Δ>0 = 关掉变差 = 机制有增益
      rows.push({
        flag,
        overall: off.overall,
        delta,
        costDeltaPerScenario: (baseline.runCostUsd - off.runCostUsd) / (scenarios.length || 1),
        conclusion: ablationConclusion(delta, NOISE),
      });
      console.error(`[bench:ablation] ${flag}: ${baseline.overall.toFixed(2)} -> ${off.overall.toFixed(2)} (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`);
    }
    const partial = flags.length < ABLATION_FLAGS.length ? `本次只跑了 ${flags.join(', ')}; 其余机制沿用上一版结论前不作数。` : '';
    const report = buildReport({ baseline, rows, note: `总成本 $${meter.totalUsd.toFixed(4)}。${partial}` });
    fs.writeFileSync(path.resolve('docs/ablation-report.md'), report);
    fs.mkdirSync(path.resolve('bench/results'), { recursive: true });
    fs.writeFileSync(
      path.resolve(`bench/results/${new Date().toISOString().slice(0, 10)}-ablation.json`),
      `${JSON.stringify({ baseline: { overall: baseline.overall, perRubric: baseline.perRubric }, rows, costUsd: meter.totalUsd }, null, 2)}\n`,
    );
    console.log(report);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
