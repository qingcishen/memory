/**
 * 真实聊天日志导入回放 CLI
 *
 * 用法：
 *   node examples/eval/import-replay.eval.js [path]
 *   npm run eval:import -- examples/eval/fixtures/sample-chat.jsonl
 *   npm run eval:import -- examples/eval/fixtures/sample-chat.txt
 *
 * 无参数时跑内置 fixtures（作为 CI 断言）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadChatLogFile,
  parseChatLog,
  replayChatLog,
  formatReplayReport,
} from '../../src/companion/chatLogImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

function runOne(label, turnsOrPath) {
  let turns;
  if (typeof turnsOrPath === 'string' && fs.existsSync(turnsOrPath)) {
    turns = loadChatLogFile(turnsOrPath, {
      userAliases: ['我', '对方'],
      assistantAliases: ['她', '可可', '小忆'],
    });
  } else if (Array.isArray(turnsOrPath)) {
    turns = turnsOrPath;
  } else {
    turns = parseChatLog(String(turnsOrPath));
  }
  const result = replayChatLog(turns);
  const report = formatReplayReport(result);
  console.log(`\n=== ${label} ===`);
  console.log(report);
  if (verbose) {
    for (const e of result.events) {
      console.log(
        `  [${e.index + 1}] ${e.primaryTopic || '-'} · ${e.structured?.attitude} · locks=${e.locks.join(',') || '-'} · ${String(e.userMessage).slice(0, 40)}`,
      );
      if (e.nonSequitur?.length || e.sessionDrift?.length) {
        console.log(`      !! ${[...(e.nonSequitur || []), ...(e.sessionDrift || [])].join('; ')}`);
      }
    }
  }
  return result;
}

let failed = 0;

if (args.length) {
  for (const p of args) {
    const r = runOne(path.basename(p), path.resolve(p));
    if (r.summary.turnPairs < 1) {
      failed++;
      console.error(`✗ ${p}: 没有解析到有效轮次`);
    } else {
      console.log(`✓ ${p}: ${r.summary.turnPairs} 轮 · topic=${r.summary.primaryTopic}`);
    }
  }
} else {
  // CI：内置 fixtures
  const jsonl = path.join(fixturesDir, 'sample-chat.jsonl');
  const txt = path.join(fixturesDir, 'sample-chat.txt');
  const r1 = runOne('sample-chat.jsonl', jsonl);
  const r2 = runOne('sample-chat.txt', txt);

  const checks = [
    ['jsonl has turns', r1.summary.turnPairs >= 3],
    ['jsonl has commitment or question trail', r1.summary.openCommitments.length + r1.summary.openQuestions.length >= 1 || r1.summary.topics.length >= 1],
    ['txt travel topic', r2.summary.primaryTopic === '出行' || r2.summary.topics.includes('出行')],
    ['txt turn pairs', r2.summary.turnPairs >= 2],
  ];
  for (const [name, ok] of checks) {
    if (!ok) {
      failed++;
      console.error(`✗ ${name}`);
    } else {
      console.log(`✓ ${name}`);
    }
  }
}

if (failed) {
  console.error(`\nimport-replay failed: ${failed}`);
  process.exit(1);
}
console.log(`\nimport-replay passed ✅`);
