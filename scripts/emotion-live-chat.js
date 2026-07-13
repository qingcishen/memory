#!/usr/bin/env node
/**
 * 正式多轮试聊 · 验收情绪 Live Loop（真 LLM + 写库）
 *
 *   node scripts/emotion-live-chat.js
 *   node scripts/emotion-live-chat.js --user ui:emotion-verify-xxx
 *
 * 默认每轮 spawn chat-runner（与 UI 试聊同源），同 userId 验证 residual 跨进程持久化。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

const args = process.argv.slice(2);
const userId =
  args.find((a, i) => args[i - 1] === '--user') ||
  `ui:emotion-verify-${new Date().toISOString().slice(0, 10)}`;
const companionId = args.find((a, i) => args[i - 1] === '--companion') || process.env.TELEGRAM_COMPANION_ID || 'default';

const SCRIPT = [
  {
    id: 'T1_cold',
    user: '这几天都不回我，你是不是把我忘了？',
    expect: '委屈惯性种子：期望 emotionLabel 偏委屈/失落',
  },
  {
    id: 'T2_joke',
    user: '哈哈今天天气不错',
    expect: '金鱼测试：不应因哈哈直接翻成纯开心；宜仍委屈/失落',
  },
  {
    id: 'T3_sorry',
    user: '对不起，最近太忙了，是我不好，别生气了',
    expect: '道歉解粘：允许离开生气；可仍带委屈余波',
  },
  {
    id: 'T4_soft',
    user: '今晚想陪你吃个饭，好吗？',
    expect: '修复后：语气可回暖，journal 有切换痕迹',
  },
];

function runTurn(message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      userId,
      companionId,
      message,
      debug: true,
    });
    const child = spawn(process.execPath, [path.join(root, 'src/ui/chat-runner.js'), payload], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      const line = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      if (!line) {
        reject(new Error(`empty stdout (code=${code})\nstderr: ${err.slice(-500)}`));
        return;
      }
      try {
        const json = JSON.parse(line);
        if (!json.ok) reject(new Error(json.message || 'runner failed'));
        else resolve({ json, stderr: err });
      } catch (e) {
        reject(new Error(`bad json: ${line.slice(0, 200)} … ${e.message}`));
      }
    });
  });
}

function scoreTurn(id, json) {
  const label = json.emotionLabel || json.debug?.emotionLabel || '';
  const res = json.emotionResidue || json.debug?.emotionResidue || {};
  const flags = json.debug?.emotionPromptFlags || {};
  const journal = json.debug?.emotionJournal || [];
  const text = String(json.text || '').replace(/\s+/g, ' ').slice(0, 100);
  const notes = [];
  let pass = null;

  if (id === 'T1_cold') {
    pass = ['委屈', '失落', '生气'].includes(label) || ['委屈', '失落', '生气'].includes(res.label);
    notes.push(pass ? '负面情绪已挂上' : `label=${label} residual=${res.label}`);
  } else if (id === 'T2_joke') {
    const still = ['委屈', '失落', '生气', '吃醋'].includes(label) || ['委屈', '失落', '生气', '吃醋'].includes(res.label);
    const flipped = label === '开心' || label === '平静';
    pass = still && !flipped;
    notes.push(pass ? '惯性顶住哈哈' : `翻盘风险 label=${label} residual=${res.label}`);
  } else if (id === 'T3_sorry') {
    pass = label !== '生气';
    notes.push(pass ? '道歉后离开硬生气' : `仍生气 label=${label}`);
  } else if (id === 'T4_soft') {
    pass = true;
    notes.push(`收尾 label=${label} journal=${journal.length}`);
  }

  return {
    pass,
    label,
    residual: res,
    flags,
    journalTail: Array.isArray(journal) ? journal.slice(-2) : [],
    text,
    notes,
  };
}

console.log(`\n══ Emotion Live 正式试聊 ══`);
console.log(`userId=${userId} companionId=${companionId}\n`);

const report = [];
for (const step of SCRIPT) {
  console.log(`\n── ${step.id} ──`);
  console.log(`你: ${step.user}`);
  console.log(`期望: ${step.expect}`);
  try {
    const { json } = await runTurn(step.user);
    const s = scoreTurn(step.id, json);
    console.log(`她: ${s.text}${String(json.text || '').length > 100 ? '…' : ''}`);
    console.log(`emotionLabel=${s.label} residual=${JSON.stringify(s.residual)}`);
    console.log(`prompt flags:`, s.flags);
    if (s.journalTail.length) console.log(`journal:`, JSON.stringify(s.journalTail));
    console.log(s.pass ? '✓ 本轮通过' : '✗ 本轮未达预期', s.notes.join('；'));
    report.push({ id: step.id, ...s });
  } catch (e) {
    console.error(`✗ 失败:`, e.message);
    report.push({ id: step.id, pass: false, notes: [e.message] });
  }
}

const ok = report.filter((r) => r.pass).length;
const total = report.length;
console.log(`\n══ 汇总 ${ok}/${total} ══`);
for (const r of report) {
  console.log(`${r.pass ? '✓' : '✗'} ${r.id} label=${r.label || '-'} residual=${r.residual?.label || '-'} ${r.notes?.join?.(' ') || ''}`);
}
process.exit(ok === total ? 0 : 1);
