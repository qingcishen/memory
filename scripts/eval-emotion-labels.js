import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EMOTION_LABELS, inferEmotionLabel } from '../src/state/emotionLabel.js';

export function classificationMetrics(rows, labels = EMOTION_LABELS) {
  const usable = rows.filter((row) => labels.includes(row.gold) && labels.includes(row.predicted));
  const confusion = Object.fromEntries(labels.map((gold) => [
    gold,
    Object.fromEntries(labels.map((predicted) => [predicted, 0])),
  ]));
  for (const row of usable) confusion[row.gold][row.predicted] += 1;
  const perLabel = Object.fromEntries(labels.map((label) => {
    const tp = confusion[label][label];
    const fp = labels.reduce((n, gold) => n + (gold === label ? 0 : confusion[gold][label]), 0);
    const fn = labels.reduce((n, predicted) => n + (predicted === label ? 0 : confusion[label][predicted]), 0);
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    return [label, {
      support: labels.reduce((n, predicted) => n + confusion[label][predicted], 0),
      precision,
      recall,
      f1: 2 * precision * recall / Math.max(Number.EPSILON, precision + recall),
    }];
  }));
  const correct = usable.filter((row) => row.gold === row.predicted).length;
  return {
    total: usable.length,
    accuracy: correct / Math.max(1, usable.length),
    macroF1: labels.reduce((sum, label) => sum + perLabel[label].f1, 0) / labels.length,
    pairF1: {
      '委屈_vs_生气': (perLabel['委屈'].f1 + perLabel['生气'].f1) / 2,
      '撒娇_vs_开心': (perLabel['撒娇'].f1 + perLabel['开心'].f1) / 2,
    },
    perLabel,
    confusion,
  };
}

export function evaluateEmotionDataset(dataset, { split = 'holdout', predictor = inferEmotionLabel } = {}) {
  const selected = split === 'all' ? dataset : dataset.filter((row) => row.split === split);
  const rows = selected.map((row) => {
    const raw = predictor(row.stateSnapshot ?? {}, row.desires ?? {}, row.lastTurns ?? []);
    return {
      id: row.id,
      gold: row.goldLabel,
      predicted: typeof raw === 'string' ? raw : raw?.label,
    };
  });
  const metrics = classificationMetrics(rows);
  return {
    split,
    ...metrics,
    thresholds: {
      accuracy: 0.85,
      confusingPairF1: 0.8,
    },
    pass:
      metrics.total > 0 &&
      metrics.accuracy >= 0.85 &&
      metrics.pairF1['委屈_vs_生气'] >= 0.8 &&
      metrics.pairF1['撒娇_vs_开心'] >= 0.8,
    rows,
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`数据集不存在：${file}`);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const file = path.resolve(process.argv.find((arg) => arg.endsWith('.jsonl')) || 'datasets/emotion-labels.jsonl');
  const split = process.argv.includes('--all') ? 'all' : 'holdout';
  const dataset = readJsonl(file);
  if (dataset.length < 300) throw new Error(`情绪金标只有 ${dataset.length} 条，验收要求至少 300 条`);
  const result = evaluateEmotionDataset(dataset, { split });
  const output = path.resolve('bench/results', `${new Date().toISOString().slice(0, 10)}-emotion-calibration.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, rows: `[${result.rows.length} rows]`, output }, null, 2));
  if (!result.pass) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[labels:eval] ${error.message}`);
    process.exitCode = 1;
  });
}
