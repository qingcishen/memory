#!/usr/bin/env node
/**
 * 亲密完整流程端到端测试
 * 先注入暖场历史建立关系 → 日常 → 升温 → 前戏 → 亲密 → 高潮 → 事后温柔
 *
 * node --env-file=.env scripts/test-intimate-flow.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userId = `test:intimate-${Date.now().toString(36).slice(-6)}`;
const companionId = process.env.TELEGRAM_COMPANION_ID || 'default';

// 先跑几轮无输出的暖场，让系统建立关系基础和亲密度
const WARMUP = [
  '清词，今天的晚饭好好吃，谢谢你做的',
  '你刚才靠在我身上的感觉……很想一直这样',
  '你今天特别好看，我一直在偷看你',
  '想亲你',
];

// 正式测试轮次：完整亲密流程
const FLOW = [
  { phase: '日常撒娇',  msg: '累了，就想躺在你身边什么都不干' },
  { phase: '升温',      msg: '你知道你对我有多大吸引力吗……我现在很想你' },
  { phase: '前戏开始',  msg: '我想要你，现在' },
  { phase: '前戏深入',  msg: '那里……轻一点，再慢一点' },
  { phase: '正式开始',  msg: '进来……别停' },
  { phase: '亲密中段',  msg: '顶着那个地方，就那里，再深一点' },
  { phase: '接近高潮',  msg: '要……要去了，别停别停' },
  { phase: '高潮后',    msg: '……就这样，压着我，哪儿都不要去' },
  { phase: '事后余韵',  msg: '刚才的感觉……太真实了，还没回过神来' },
];

function runTurn(message, silent = false) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ userId, companionId, message, debug: !silent });
    const child = spawn(process.execPath, [path.join(root, 'src/ui/chat-runner.js'), payload], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 120_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (!line) return reject(new Error(`empty stdout\n${err.slice(-300)}`));
      try {
        const json = JSON.parse(line);
        if (!json.ok) reject(new Error(json.message || 'runner error'));
        else resolve(json);
      } catch (e) {
        reject(new Error(`json parse: ${e.message}\nraw: ${line.slice(0, 200)}`));
      }
    });
  });
}

function fmt(json) {
  const parts = json.parts || [];
  if (!parts.length) return `  ${json.text || ''}`;
  return parts.map((p) => {
    if (p.type === 'narration') return `  [旁白] ${p.text}`;
    return `  ${p.text}`;
  }).join('\n');
}

function meta(json) {
  const d = json.debug || {};
  const locks = (d.sceneLocks || json.sceneLocks || [])
    .map((l) => (typeof l === 'string' ? l : l?.id)).join(',');
  const hints = d.samplingHints || {};
  const partTypes = (json.parts || []).map((p) => p.type).join('+');
  return [
    `情绪=${json.emotionLabel || '-'}`,
    `阶段=${d.intimacyPhase || '-'}`,
    `场景锁=${locks || '无'}`,
    `parts=[${partTypes || '-'}]`,
    `t=${hints.temperature ?? '-'}`,
    `p=${hints.top_p ?? '-'}`,
  ].join('  ');
}

console.log(`\n${'='.repeat(64)}`);
console.log(`亲密完整流程测试  userId=${userId}`);
console.log(`${'='.repeat(64)}\n`);

// 暖场（静默，建立关系/亲密基础）
process.stdout.write('【暖场预热中，共 4 轮...】');
for (const msg of WARMUP) {
  try { await runTurn(msg, true); process.stdout.write(' ok'); } catch { process.stdout.write(' err'); }
}
console.log('\n');

// 正式测试
let prevPhase = null;
for (const { phase, msg } of FLOW) {
  if (phase !== prevPhase) {
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`【${phase}】`);
    console.log(`${'─'.repeat(40)}`);
    prevPhase = phase;
  }
  console.log(`\n你: ${msg}`);
  try {
    const json = await runTurn(msg);
    console.log(`她:\n${fmt(json)}`);
    console.log(`  └ ${meta(json)}`);
  } catch (e) {
    console.error(`  ✗ 出错: ${e.message}`);
  }
}

console.log(`\n${'='.repeat(64)}`);
console.log('测试完毕');
