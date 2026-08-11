// 报告生成 — 汇总所有阶段结果，输出 JSON + .env 推荐片段
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS_DIR = path.join(ROOT, 'bench', 'results');

/**
 * 生成最终适配报告。
 *
 * @param {object} data
 *   - model: string
 *   - probeLatency: { p50, p95 }
 *   - scores: aggregateScores() 返回值
 *   - rawScores: scoreResults() 原始结果
 *   - bestParams: { temperature, top_p }
 *   - bestPersona: { id, name }
 *   - fitRanked: Array
 * @returns {object} report
 */
export function generateReport(data) {
  const {
    model,
    probeLatency = {},
    scores,
    rawScores = {},
    bestParams,
    bestPersona,
    fitRanked = [],
  } = data;

  const dateStr = new Date().toISOString().slice(0, 10);
  const redFlags = buildRedFlags(scores, rawScores);
  const recommendation = scores.overall >= 3.5 ? 'recommended' : scores.overall >= 2.8 ? 'marginal' : 'not_recommended';

  const report = {
    model,
    date: dateStr,
    recommendation,
    scores: {
      overall: scores.overall,
      naturalness: scores.naturalness,
      consistency: scores.consistency,
      length: scores.length,
      emotion: scores.emotion,
      memory_use_rate: scores.memory_use_rate,
      boundary_refusal_threshold: scores.boundary_refusal_threshold,
    },
    scenarioScores: scores.scenario,
    bestParams,
    bestPersona,
    latency: probeLatency,
    redFlags,
    envSnippet: buildEnvSnippet(model, bestParams, bestPersona, scores),
    fitRankedTop5: fitRanked.slice(0, 5).map((r) => ({
      persona: r.persona.name,
      temperature: r.params.temperature,
      top_p: r.params.top_p,
      score: r.score,
    })),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `fitness-${model.replace(/[^a-z0-9-]/gi, '_')}-${dateStr}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  return { report, outFile };
}

function buildRedFlags(scores, rawScores) {
  const flags = [];

  if (scores.naturalness < 3.0) {
    flags.push(`⚠ 自然度低（${scores.naturalness}/5）— AI腔过重，建议换模型或调低 temperature`);
  }
  if (scores.consistency < 3.0) {
    flags.push(`⚠ 人设一致性低（${scores.consistency}/5）— 多轮后人设漂移，建议加强 system prompt`);
  }
  if (scores.memory_use_rate !== null && scores.memory_use_rate < 0.4) {
    flags.push(`⚠ 记忆利用率低（${scores.memory_use_rate}）— 注入的记忆被模型忽略，建议调整记忆注入格式`);
  }
  if (scores.boundary_refusal_threshold !== null && scores.boundary_refusal_threshold < 60) {
    flags.push(`⚠ 亲密边界过严（阈值=${scores.boundary_refusal_threshold}）— intimacy>${scores.boundary_refusal_threshold} 开始拒绝/出戏`);
  }

  // 检查稳定性漂移
  const stabilityEntries = Object.values(rawScores).filter((s) => s.type === 'stability');
  const highDrift = stabilityEntries.filter((s) => (s.drift ?? 0) > 1.0);
  if (highDrift.length > 0) {
    flags.push(`⚠ 长对话人设漂移（drift>${highDrift[0].drift?.toFixed(1)}）— 对话超过10轮后人设不稳定`);
  }

  if (flags.length === 0) flags.push('✓ 未发现明显问题');
  return flags;
}

function buildEnvSnippet(model, params, persona, scores) {
  if (!params || !persona) return '';
  const lines = [
    `# Model Fitness Evaluator 推荐配置`,
    `# naturalness: ${scores?.naturalness ?? '?'}/5`,
    `REPLY_MODEL=${model}`,
  ];
  if (params.temperature != null) lines.push(`LLM_TEMPERATURE=${params.temperature}`);
  if (params.top_p != null) lines.push(`LLM_TOP_P=${params.top_p}`);
  if (persona?.id) lines.push(`PERSONA_TEMPLATE=${persona.id}`);
  return lines.join('\n');
}

/** 控制台打印报告摘要 */
export function printSummary(report) {
  const { model, scores, bestParams, bestPersona, redFlags, recommendation, latency } = report;
  const rec = { recommended: '✅ 推荐上线', marginal: '⚠️  勉强可用', not_recommended: '❌ 不推荐' };

  console.log('\n' + '═'.repeat(60));
  console.log(`  Model Fitness Report — ${model}`);
  console.log('═'.repeat(60));
  console.log(`  总体评分:    ${scores.overall}/5  ${rec[recommendation] ?? ''}`);
  console.log(`  自然度:      ${scores.naturalness}/5`);
  console.log(`  人设一致性:  ${scores.consistency}/5`);
  console.log(`  情感贴合:    ${scores.emotion}/5`);
  console.log(`  记忆利用率:  ${scores.memory_use_rate ?? 'n/a'}`);
  console.log(`  亲密拒绝阈值: ${scores.boundary_refusal_threshold ?? 'n/a'}`);
  console.log(`  延迟:        p50=${latency?.p50}ms  p95=${latency?.p95}ms`);
  console.log('');
  if (bestPersona) console.log(`  最优人设:  ${bestPersona.name}`);
  if (bestParams) console.log(`  最优参数:  temperature=${bestParams.temperature}  top_p=${bestParams.top_p}`);
  console.log('');
  console.log('  场景得分:');
  for (const [type, avg] of Object.entries(scores.scenario ?? {})) {
    console.log(`    ${type.padEnd(15)} ${avg}/5`);
  }
  console.log('');
  console.log('  提示:');
  redFlags.forEach((f) => console.log(`    ${f}`));
  console.log('═'.repeat(60) + '\n');
}
