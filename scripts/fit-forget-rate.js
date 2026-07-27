import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function fitForgetRate(samples) {
  const points = samples.filter((x) => x.ageDays > 0 && x.recallRate > 0 && x.recallRate <= 1)
    .map((x) => [Math.log(x.ageDays), Math.log(x.recallRate)]);
  if (points.length < 3) return { samples: points.length, recommend: false, reason: 'insufficient_data' };
  const mx = points.reduce((n, point) => n + point[0], 0) / points.length;
  const my = points.reduce((n, point) => n + point[1], 0) / points.length;
  const variance = points.reduce((n, point) => n + (point[0] - mx) ** 2, 0);
  const slope = points.reduce((n, point) => n + (point[0] - mx) * (point[1] - my), 0)
    / Math.max(Number.EPSILON, variance);
  const intercept = my - slope * mx;
  const predicted = points.map(([x]) => intercept + slope * x);
  const sse = points.reduce((n, point, index) => n + (point[1] - predicted[index]) ** 2, 0);
  const sst = points.reduce((n, point) => n + (point[1] - my) ** 2, 0);
  const r2 = 1 - sse / Math.max(Number.EPSILON, sst);
  return {
    samples: points.length,
    forgetRate: Math.max(0, -slope),
    intercept,
    r2,
    recommend: slope < 0 && r2 >= 0.6,
    reason: slope >= 0 ? 'non_decaying_observations' : r2 < 0.6 ? 'poor_fit' : 'supported',
  };
}

/**
 * Turns raw access logs into cohort-normalized recall density by age bucket.
 * It only uses memories old enough to be exposed to each bucket, avoiding young-row bias.
 */
export function deriveRecallSamples(memories, { now = Date.now(), buckets = [1, 3, 7, 14, 30, 60] } = {}) {
  const raw = buckets.map((ageDays, index) => {
    const next = buckets[index + 1] ?? ageDays * 1.5;
    const eligible = memories.filter((row) => (now - Date.parse(row.created_at)) / 86400000 >= next);
    const hits = eligible.reduce((sum, row) => {
      const created = Date.parse(row.created_at);
      const found = (row.access_log ?? []).some((stamp) => {
        const age = (Date.parse(stamp) - created) / 86400000;
        return age >= ageDays && age < next;
      });
      return sum + Number(found);
    }, 0);
    return { ageDays, eligible: eligible.length, hits, density: hits / Math.max(1, eligible.length) };
  }).filter((row) => row.eligible >= 20);
  const maxDensity = Math.max(...raw.map((row) => row.density), 0);
  return raw.map((row) => ({
    ...row,
    recallRate: maxDensity > 0 ? row.density / maxDensity : 0,
  }));
}

export function fitImportanceWeights(rows, { iterations = 3000, learningRate = 0.01 } = {}) {
  const usable = rows.filter((row) => Number.isFinite(Number(row.goldImportance)) && row.content);
  const featureNames = ['bias', 'length', 'boundary', 'preference', 'commitment', 'ephemeral'];
  if (usable.length < 30) return { samples: usable.length, recommend: false, reason: 'insufficient_data', featureNames };
  const vectors = usable.map((row) => importanceFeatures(row.content));
  const targets = usable.map((row) => Number(row.goldImportance) / 10);
  const weights = new Array(featureNames.length).fill(0);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = new Array(weights.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const prediction = dot(weights, vectors[i]);
      const error = prediction - targets[i];
      for (let j = 0; j < weights.length; j++) gradient[j] += error * vectors[i][j];
    }
    for (let j = 0; j < weights.length; j++) weights[j] -= learningRate * gradient[j] / vectors.length;
  }
  const predictions = vectors.map((vector) => dot(weights, vector));
  const mean = targets.reduce((a, b) => a + b, 0) / targets.length;
  const sse = targets.reduce((sum, target, index) => sum + (target - predictions[index]) ** 2, 0);
  const sst = targets.reduce((sum, target) => sum + (target - mean) ** 2, 0);
  const r2 = 1 - sse / Math.max(Number.EPSILON, sst);
  return {
    samples: usable.length,
    featureNames,
    weights: Object.fromEntries(featureNames.map((name, index) => [name, weights[index]])),
    r2,
    recommend: r2 >= 0.6,
    reason: r2 >= 0.6 ? 'supported' : 'poor_fit',
  };
}

function importanceFeatures(content) {
  const text = String(content);
  return [
    1,
    Math.min(1, text.length / 100),
    Number(/不能|不要|过敏|底线|边界|害怕/u.test(text)),
    Number(/喜欢|讨厌|偏好|习惯/u.test(text)),
    Number(/答应|约定|记得|生日|纪念|结婚|承诺/u.test(text)),
    Number(/今天|刚才|临时|随便|天气/u.test(text)),
  ];
}

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

async function fetchAllMemories() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error('生产拟合需要 SUPABASE_URL 与 SUPABASE_KEY');
  }
  const { supabase } = await import('../src/config.js');
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('memories')
      .select('id, created_at, access_log, importance')
      .not('user_id', 'like', 'bench\\_%')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const memories = await fetchAllMemories();
  const oldest = memories.reduce((min, row) => Math.min(min, Date.parse(row.created_at)), Date.now());
  const spanDays = memories.length ? (Date.now() - oldest) / 86400000 : 0;
  const recallSamples = deriveRecallSamples(memories);
  const forget = spanDays >= 60
    ? fitForgetRate(recallSamples)
    : { samples: recallSamples.length, recommend: false, reason: 'less_than_60_days' };
  const importanceRows = readJsonl(path.resolve('datasets/importance-labels.jsonl'));
  const importance = fitImportanceWeights(importanceRows);
  const report = {
    ts: new Date().toISOString(),
    productionRows: memories.length,
    spanDays,
    recallSamples,
    forget,
    importance,
    applied: false,
    decision:
      forget.recommend && importance.recommend
        ? '参数有统计支持；仍需先跑 E1 回归，脚本不会直接改线上默认'
        : '数据不支持替换，沿用 params.js 默认值',
  };
  const output = path.resolve('bench/results', `${report.ts.slice(0, 10)}-parameter-fit.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[fit:forget-rate] ${error.message}`);
    process.exitCode = 1;
  });
}
