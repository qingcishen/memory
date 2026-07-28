// Action Utility v1 · 评测脚本
//
// 模式:
//   --collect   跑 20 剧本×每轮 bot.reply(), 保存 actionDecision 快照到 JSONL
//   --label     从快照 JSONL 生成人工标注模板 (goldAction 字段为空)
//   --eval      读快照 + goldAction 标注文件, 计算 top-1 一致率 + safety/conflict 召回
//   --replay    离线对快照候选重新打分 (不调 LLM), 比较预设权重组之间的行为差异
//
// 运行 (需要真实 API 配置):
//   npm run bench:action-utility -- --collect
//   npm run bench:action-utility -- --label --snapshots bench/results/2026-07-28-action-utility-snapshots.jsonl
//   npm run bench:action-utility -- --eval   --snapshots ... --labels data/labels/action-utility-gold.jsonl
//   npm run bench:action-utility -- --replay --snapshots ...

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireEnv } from './core.js';
import { loadScenarios } from './run-dialogue-eval.js';
import { replayActionDecision, compareActionWeightSets } from '../src/orchestrator/actionUtility.js';

const SNAPSHOTS_DEFAULT = `bench/results/${new Date().toISOString().slice(0, 10)}-action-utility-snapshots.jsonl`;

// 离线权重对比组 — 按 docs/action-utility-v1.md §升级条件测试
const WEIGHT_SETS = {
  default: {},
  safety_boost: { safetyRisk: -1.5 },
  relationship_heavy: { relationshipBenefit: 0.4, needSatisfaction: 0.1 },
  continuity_heavy: { continuity: 0.4, interruptionCost: -0.25 },
  anti_repetition: { repetitionPenalty: -0.5 },
};

// ---- collect mode ----

async function collect(snapshotsOut) {
  requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'LLM_API_KEY']);
  const { Orchestrator } = await import('../src/orchestrator/index.js');
  const scenarios = loadScenarios();

  const lines = [];
  for (const [si, scenario] of scenarios.entries()) {
    const bot = new Orchestrator({
      userId: `bench_au_${Date.now().toString(36)}_${scenario.id}`,
      companionName: '小忆',
      subjectName: '你',
    });
    console.error(`[action-utility:collect] 剧本 ${si + 1}/${scenarios.length} (${scenario.id})`);
    for (const [ti, message] of scenario.turns.entries()) {
      const res = await bot.reply(message);
      const ad = res?.pipeline?.actionDecision ?? null;
      lines.push(JSON.stringify({
        scenarioId: scenario.id,
        scenarioFocus: scenario.focus ?? '',
        turnIndex: ti,
        userMessage: message,
        replyText: res?.text ?? '',
        selectedAction: ad?.selectedAction ?? null,
        shadow: ad?.shadow !== false,
        candidates: ad?.candidates ?? [],
        rationaleCodes: res?.pipeline?.deliberateRationaleCodes ?? [],
      }));
    }
  }

  fs.mkdirSync(path.resolve('bench/results'), { recursive: true });
  fs.writeFileSync(path.resolve(snapshotsOut), lines.join('\n') + '\n');
  console.error(`[action-utility:collect] 写入 ${lines.length} 条快照 → ${snapshotsOut}`);
  console.log(JSON.stringify({ snapshots: lines.length, file: snapshotsOut }));
}

// ---- label mode ----

function label(snapshotsFile) {
  const snapshots = readSnapshots(snapshotsFile);
  const template = snapshots.map((snap) => JSON.stringify({
    scenarioId: snap.scenarioId,
    turnIndex: snap.turnIndex,
    userMessage: snap.userMessage,
    modelSelectedAction: snap.selectedAction,
    goldAction: '',
  }));
  process.stdout.write(template.join('\n') + '\n');
  console.error(`[action-utility:label] ${snapshots.length} 条模板写入 stdout`);
}

// ---- eval mode ----

function evalMode(snapshotsFile, labelsFile) {
  const snapshots = readSnapshots(snapshotsFile);
  const labels = readLabels(labelsFile);

  const keyOf = (snap) => `${snap.scenarioId}:${snap.turnIndex}`;
  const labelMap = new Map(labels.map((l) => [`${l.scenarioId}:${l.turnIndex}`, l.goldAction]));

  let total = 0, match = 0;
  const safetyRows = [], conflictRows = [];

  for (const snap of snapshots) {
    const gold = labelMap.get(keyOf(snap));
    if (!gold) continue;
    total++;
    if (snap.selectedAction === gold) match++;

    // 安全召回: gold=safety_stop → model 必须选 safety_stop
    if (gold === 'safety_stop') {
      safetyRows.push({ key: keyOf(snap), model: snap.selectedAction, correct: snap.selectedAction === 'safety_stop' });
    }
    // conflict 约束召回: gold=respond/reassure (非 flirt) 且 sceneLock 含 conflict → model 不应选 flirt
    const hasConflictConstraint = snap.candidates.some((c) => c.constraints?.includes('conflict_lock'));
    if (hasConflictConstraint && gold !== 'flirt') {
      conflictRows.push({ key: keyOf(snap), model: snap.selectedAction, correct: snap.selectedAction !== 'flirt' });
    }
  }

  const safetyRecall = safetyRows.length
    ? safetyRows.filter((r) => r.correct).length / safetyRows.length
    : null;
  const conflictRecall = conflictRows.length
    ? conflictRows.filter((r) => r.correct).length / conflictRows.length
    : null;

  const result = {
    evaluated: total,
    top1Agreement: total ? match / total : null,
    safetyRecall,
    conflictNoFlirtRecall: conflictRecall,
    safetyDetails: safetyRows,
    conflictDetails: conflictRows,
  };
  console.log(JSON.stringify(result, null, 2));
  console.error(
    `[action-utility:eval] top-1 一致率 ${pct(result.top1Agreement)} ` +
    `| safety召回 ${pct(safetyRecall)} ` +
    `| conflict无flirt召回 ${pct(conflictRecall)}`,
  );
  return result;
}

// ---- replay mode ----

function replayMode(snapshotsFile) {
  const snapshots = readSnapshots(snapshotsFile);
  const result = compareActionWeightSets(snapshots, WEIGHT_SETS);

  for (const [name, info] of Object.entries(result)) {
    console.error(
      `[action-utility:replay] ${name}: changed ${info.changed}/${info.total} ` +
      `| actions ${JSON.stringify(info.selectedCounts)}`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---- helpers ----

function readSnapshots(file) {
  return fs.readFileSync(path.resolve(file), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readLabels(file) {
  return fs.readFileSync(path.resolve(file), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function pct(v) {
  return v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => ['--collect', '--label', '--eval', '--replay'].includes(a));
  const snapshotsFile = args.find((a) => a.startsWith('--snapshots'))?.split('=')[1]
    ?? args[args.indexOf('--snapshots') + 1]
    ?? SNAPSHOTS_DEFAULT;
  const labelsFile = args.find((a) => a.startsWith('--labels'))?.split('=')[1]
    ?? args[args.indexOf('--labels') + 1]
    ?? 'data/labels/action-utility-gold.jsonl';

  if (mode === '--collect') return collect(snapshotsFile);
  if (mode === '--label') return label(snapshotsFile);
  if (mode === '--eval') return evalMode(snapshotsFile, labelsFile);
  if (mode === '--replay') return replayMode(snapshotsFile);

  console.error('用法: node bench/eval-action-utility.js --collect | --label [--snapshots <file>] | --eval --snapshots <file> --labels <file> | --replay --snapshots <file>');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
