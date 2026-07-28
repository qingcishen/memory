/**
 * T-05 Phase 2: k-NN 情绪分类器（数值特征 + 文本 embedding 混合）。
 * 训练后输出模型到 data/models/emotion-knn.json。
 *
 * 运行: node --env-file=.env scripts/train-emotion-knn.js
 *       [--dataset data/labels/2026-07-27.labeled.jsonl] [--k 7]
 *       [--num-weight 0.3]   # 数值特征权重 (默认 0.3，embedding 权重 1-0.3=0.7)
 */

import fs from 'node:fs';
import path from 'node:path';
import { EMOTION_LABELS } from '../src/state/emotionLabel.js';
import { embedder, EMBED_MODEL } from '../src/config.js';

const DEFAULT_DATASET = 'data/labels/2026-07-27.labeled.jsonl';
const DEFAULT_K = 7;
const DEFAULT_NUM_WEIGHT = 0.3;

/** 9 维数值特征 */
export function extractNumericFeatures(stateSnapshot = {}, desires = {}) {
  const emotion = stateSnapshot.emotion ?? stateSnapshot.mood ?? {};
  const rel = stateSnapshot.relationship ?? {};
  const intimacy = stateSnapshot.intimacy ?? {};
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(v) || 0));
  return [
    clamp(emotion.valence, -1, 1),
    clamp(emotion.warmth ?? rel.closeness ?? 0.5),
    clamp(rel.closeness ?? 0.5),
    clamp(rel.tension ?? 0),
    clamp(rel.repair_debt ?? 0),
    clamp(desires.attention ?? 0),
    clamp(desires.comfort ?? 0),
    clamp(desires.security ?? 0),
    clamp(intimacy.arousal ?? 0),
  ];
}

/** 从 lastTurns 提取用于 embedding 的文本 */
export function turnsToText(lastTurns = []) {
  return (Array.isArray(lastTurns) ? lastTurns : [])
    .slice(-2)
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.content}`)
    .join('\n');
}

async function getEmbeddings(texts, batchSize = 32) {
  const all = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await embedder.embeddings.create({ model: EMBED_MODEL, input: batch });
    all.push(...res.data.map((d) => d.embedding));
  }
  return all;
}

function normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function mixedFeatures(numVec, embedVec, numWeight) {
  const embWeight = 1 - numWeight;
  return [
    ...normalize(numVec).map((x) => x * numWeight),
    ...normalize(embedVec).map((x) => x * embWeight),
  ];
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

export function knnPredict(trainSamples, k, features) {
  const distances = trainSamples.map(({ features: tf, label }) => ({
    label,
    distance: euclideanDistance(features, tf),
  }));
  distances.sort((a, b) => a.distance - b.distance);
  const neighbors = distances.slice(0, k);
  const votes = {};
  for (const { label } of neighbors) votes[label] = (votes[label] ?? 0) + 1;
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
}

function computeMetrics(predictions, labels) {
  const correct = predictions.filter(({ gold, pred }) => gold === pred).length;
  const acc = correct / Math.max(1, predictions.length);
  const perLabel = {};
  for (const label of labels) {
    const tp = predictions.filter(({ gold, pred }) => gold === label && pred === label).length;
    const fp = predictions.filter(({ gold, pred }) => gold !== label && pred === label).length;
    const fn = predictions.filter(({ gold, pred }) => gold === label && pred !== label).length;
    const p = tp / Math.max(1, tp + fp);
    const r = tp / Math.max(1, tp + fn);
    perLabel[label] = { tp, fp, fn, p, r, f1: (2 * p * r) / Math.max(1e-10, p + r), support: tp + fn };
  }
  const macro = Object.values(perLabel).reduce((s, m) => s + m.f1, 0) / labels.length;
  return { accuracy: acc, macroF1: macro, perLabel };
}

function loadDataset(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.kind === 'emotion' && EMOTION_LABELS.includes(row.initialLabel)) rows.push(row);
  }
  return rows;
}

function parseCli() {
  const args = process.argv.slice(2);
  const get = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };
  return {
    dataset: get('--dataset', DEFAULT_DATASET),
    k: Number(get('--k', DEFAULT_K)),
    numWeight: Number(get('--num-weight', DEFAULT_NUM_WEIGHT)),
  };
}

async function main() {
  const { dataset, k, numWeight } = parseCli();
  const rows = loadDataset(path.resolve(dataset));
  if (rows.length < 10) throw new Error(`Too few samples: ${rows.length}`);

  console.error(`[train-emotion-knn] ${rows.length} samples, k=${k}, numWeight=${numWeight}`);
  console.error(`[train-emotion-knn] embedding ${rows.length} samples with ${EMBED_MODEL}...`);

  const texts = rows.map((row) => turnsToText(row.lastTurns));
  const embeddings = await getEmbeddings(texts);

  // 20% holdout split by candidateId hash (deterministic)
  const holdoutN = Math.floor(rows.length * 0.2);
  const holdout = rows.slice(0, holdoutN);
  const train = rows.slice(holdoutN);
  const holdoutEmb = embeddings.slice(0, holdoutN);
  const trainEmb = embeddings.slice(holdoutN);

  console.error(`[train-emotion-knn] train=${train.length} holdout=${holdout.length}`);

  const trainSamples = train.map((row, i) => ({
    label: row.initialLabel,
    numFeatures: extractNumericFeatures(row.stateSnapshot ?? {}, row.desires ?? {}),
    embedding: trainEmb[i],
    features: mixedFeatures(
      extractNumericFeatures(row.stateSnapshot ?? {}, row.desires ?? {}),
      trainEmb[i],
      numWeight,
    ),
  }));

  // Evaluate on holdout
  const predictions = holdout.map((row, i) => {
    const features = mixedFeatures(
      extractNumericFeatures(row.stateSnapshot ?? {}, row.desires ?? {}),
      holdoutEmb[i],
      numWeight,
    );
    return { gold: row.initialLabel, pred: knnPredict(trainSamples, k, features) };
  });

  const metrics = computeMetrics(predictions, EMOTION_LABELS);
  console.log(`[train-emotion-knn] holdout accuracy: ${(metrics.accuracy * 100).toFixed(1)}%`);
  console.log(`[train-emotion-knn] holdout macroF1:  ${(metrics.macroF1 * 100).toFixed(1)}%`);
  for (const [label, m] of Object.entries(metrics.perLabel)) {
    if (m.support > 0)
      console.log(`  ${label}: support=${m.support} p=${(m.p * 100).toFixed(0)}% r=${(m.r * 100).toFixed(0)}% f1=${(m.f1 * 100).toFixed(0)}%`);
  }

  // Save model (store train samples without full embedding to save space — use numFeatures+embedding separately)
  const model = {
    version: 2,
    type: 'knn-mixed',
    k,
    numWeight,
    embedModel: EMBED_MODEL,
    labels: EMOTION_LABELS,
    trainSamples: trainSamples.map(({ label, numFeatures, embedding }) => ({ label, numFeatures, embedding })),
    trainedAt: new Date().toISOString(),
    trainSize: train.length,
    holdoutSize: holdout.length,
    holdoutAccuracy: metrics.accuracy,
    holdoutMacroF1: metrics.macroF1,
    perLabel: metrics.perLabel,
  };
  const outDir = path.resolve('data/models');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'emotion-knn.json');
  fs.writeFileSync(outFile, JSON.stringify(model) + '\n');
  console.error(`[train-emotion-knn] model saved to ${outFile}`);
  return metrics;
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
