#!/usr/bin/env node
/**
 * 多场景正式试聊 · 真 LLM + 写库
 *
 *   node scripts/emotion-live-chat.js
 *   node scripts/emotion-live-chat.js --scenario neglect_inertia,jealous_inertia
 *   node scripts/emotion-live-chat.js --all-llm
 *   node scripts/emotion-live-chat.js --user ui:xxx
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

const scenarios = JSON.parse(
  fs.readFileSync(path.join(root, 'examples/eval/live-scenarios.json'), 'utf8'),
);

const args = process.argv.slice(2);
const allLlm = args.includes('--all-llm');
const scenarioArg = args.find((a, i) => args[i - 1] === '--scenario');
const userBase =
  args.find((a, i) => args[i - 1] === '--user') ||
  `ui:live-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const companionId =
  args.find((a, i) => args[i - 1] === '--companion') || process.env.TELEGRAM_COMPANION_ID || 'default';

// 默认真聊：高风险 5 条；--all-llm 全 live；--scenario a,b 指定
const DEFAULT_LIVE = ['neglect_inertia', 'jealous_inertia', 'angry_soft_repair', 'intimate_no_class', 'cross_process_sticky'];

function pickScenarios() {
  if (scenarioArg) {
    const ids = scenarioArg.split(',').map((s) => s.trim());
    return scenarios.filter((s) => ids.includes(s.id) && s.live !== false);
  }
  if (allLlm) return scenarios.filter((s) => s.live || s.liveOnly);
  return scenarios.filter((s) => DEFAULT_LIVE.includes(s.id));
}

function runTurn(userId, message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ userId, companionId, message, debug: true });
    const child = spawn(process.execPath, [path.join(root, 'src/ui/chat-runner.js'), payload], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('turn timeout 300s'));
    }, 300000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        reject(new Error(`empty stdout\n${err.slice(-400)}`));
        return;
      }
      try {
        const json = JSON.parse(line);
        if (!json.ok) reject(new Error(json.message || 'runner failed'));
        else resolve(json);
      } catch (e) {
        reject(new Error(`bad json ${e.message}`));
      }
    });
  });
}

function checkExpect(exp = {}, json) {
  const label = json.emotionLabel || json.debug?.emotionLabel || '';
  const resLabel = json.emotionResidue?.label || json.debug?.emotionResidue?.label || '';
  const notes = [];
  let pass = true;

  const hit = (list) => list.includes(label) || list.includes(resLabel);

  if (exp.labelsAny?.length) {
    const ok = hit(exp.labelsAny);
    if (!ok) {
      pass = false;
      notes.push(`want labels ${exp.labelsAny.join('|')} got ${label}/${resLabel}`);
    }
  }
  if (exp.notLabels?.length) {
    if (exp.notLabels.includes(label) || exp.notLabels.includes(resLabel)) {
      pass = false;
      notes.push(`forbid ${label}/${resLabel}`);
    }
  }
  if (exp.sceneLockAny?.length) {
    const locks = json.sceneLocks || json.debug?.sceneLocks || [];
    const ids = Array.isArray(locks) ? locks.map((l) => (typeof l === 'string' ? l : l.id)) : [];
    if (!exp.sceneLockAny.some((id) => ids.includes(id))) {
      notes.push(`locks missing want ${exp.sceneLockAny.join('|')} got ${ids.join(',') || 'n/a'}`);
      // 真聊 soft：有 label 预期时 locks 失败不整轮打挂，只记 note
      if (!exp.labelsAny?.length) pass = false;
    }
  }
  // 负面标签时期望表现段进 system（验收 has表现）
  if (exp.expect表现 || ['委屈', '吃醋', '生气', '失落', '撒娇', '心疼'].includes(label) || ['委屈', '吃醋', '生气', '失落', '撒娇', '心疼'].includes(resLabel)) {
    const flags = json.debug?.emotionPromptFlags || {};
    if (flags.has表现 === false) {
      notes.push('has表现=false');
      if (exp.require表现) pass = false;
    }
  }
  return { pass, notes, label, resLabel };
}

const selected = pickScenarios();
console.log(`\n══ Live multi-scenario (${selected.length}) userBase=${userBase} ══\n`);

const report = [];
for (const s of selected) {
  const userId = s.fixedUserId ? `${userBase}-${s.id}` : `${userBase}-${s.id}-${Date.now().toString(36).slice(-4)}`;
  console.log(`\n######## ${s.id}: ${s.title} ########`);
  console.log(`userId=${userId}`);
  const turnResults = [];
  let scenarioPass = true;

  for (let i = 0; i < (s.turns || []).length; i++) {
    const turn = s.turns[i];
    console.log(`\n── ${s.id} T${i + 1} ──`);
    console.log(`你: ${turn.user}`);
    try {
      const json = await runTurn(userId, turn.user);
      const text = String(json.text || '').replace(/\s+/g, ' ').slice(0, 120);
      const scored = checkExpect(turn.expect || {}, json);
      console.log(`她: ${text}${String(json.text || '').length > 120 ? '…' : ''}`);
      console.log(
        `label=${scored.label} residual=${scored.resLabel} flags=`,
        json.debug?.emotionPromptFlags || {},
      );
      if (json.debug?.emotionJournal?.length) {
        console.log(`journal:`, JSON.stringify(json.debug.emotionJournal.slice(-2)));
      }
      console.log(scored.pass ? '✓' : '✗', scored.notes.join('; ') || 'ok');
      if (!scored.pass) scenarioPass = false;
      turnResults.push({
        user: turn.user,
        text,
        label: scored.label,
        residual: scored.resLabel,
        pass: scored.pass,
        notes: scored.notes,
        flags: json.debug?.emotionPromptFlags,
      });
    } catch (e) {
      console.error('✗', e.message);
      scenarioPass = false;
      turnResults.push({ user: turn.user, pass: false, notes: [e.message] });
    }
  }

  report.push({ id: s.id, title: s.title, pass: scenarioPass, turns: turnResults });
  console.log(scenarioPass ? `\n✓ scenario ${s.id}` : `\n✗ scenario ${s.id}`);
}

// 写报告
const logsDir = path.join(root, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const reportPath = path.join(logsDir, `live-matrix-${Date.now()}.md`);
const okN = report.filter((r) => r.pass).length;
const lines = [
  `# Live multi-scenario report`,
  ``,
  `- date: ${new Date().toISOString()}`,
  `- userBase: ${userBase}`,
  `- result: **${okN}/${report.length}**`,
  ``,
];
for (const r of report) {
  lines.push(`## ${r.pass ? '✓' : '✗'} ${r.id} — ${r.title}`);
  for (const t of r.turns) {
    lines.push(`- **你**: ${t.user}`);
    lines.push(`  - 她: ${t.text || '(fail)'}`);
    lines.push(`  - label=${t.label || '-'} residual=${t.residual || '-'} ${t.pass ? '✓' : '✗'} ${(t.notes || []).join('; ')}`);
  }
  lines.push('');
}
const fails = report.filter((r) => !r.pass);
if (fails.length) {
  lines.push(`## Backlog`);
  for (const f of fails) {
    lines.push(`- **${f.id}**: ${f.turns.filter((t) => !t.pass).map((t) => t.notes?.join?.(' ')).join(' | ')}`);
  }
}
fs.writeFileSync(reportPath, lines.join('\n'));
console.log(`\n══ 汇总 ${okN}/${report.length} ══`);
for (const r of report) console.log(`${r.pass ? '✓' : '✗'} ${r.id}`);
console.log(`report: ${reportPath}`);
process.exit(okN === report.length ? 0 : 1);
