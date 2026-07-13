/**
 * 多轮日志回放评测（无 LLM）
 * 对脚本化 transcript 跑：会话线 / 场景锁 / 结构化计划 / 连贯检改 / drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptySessionThread,
  updateSessionThread,
  sessionThreadToPrompt,
  detectSessionDrift,
  sessionHooksToUnfinished,
} from '../../src/companion/sessionThread.js';
import { detectSceneLocks, detectNonSequitur } from '../../src/companion/sceneCoherence.js';
import { planStructuredHeuristic } from '../../src/orchestrator/structuredPlan.js';
import { buildConversationGoals } from '../../src/orchestrator/goals.js';
import { buildSystemPrompt } from '../../src/orchestrator/assemble.js';
import { behaviorPolicy } from '../../src/state/behavior.js';
import { inferRelationshipStage, applyStageToBehavior } from '../../src/companion/relationshipStage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'replay-sessions.scenarios.json'), 'utf8'));

let failed = 0;
let passed = 0;

for (const s of scenarios) {
  let thread = emptySessionThread(1);
  const history = [];
  const checks = [];
  let lastStructured = null;
  let lastLocks = [];

  for (let i = 0; i < (s.turns || []).length; i++) {
    const turn = s.turns[i];
    const userMessage = turn.user;
    const fakeReply = turn.assistant || '';
    const intimacyPhase = turn.intimacyPhase || s.intimacyPhase || null;
    const locks = detectSceneLocks(userMessage, history, intimacyPhase);
    lastLocks = locks;

    const rel = s.relationship || { closeness: 0.75, trust: 0.7, tension: 0.1, repair_debt: 0 };
    let behavior = behaviorPolicy('平静', { relationship: rel });
    behavior = applyStageToBehavior(behavior, inferRelationshipStage(rel));

    thread = updateSessionThread(thread, {
      userMessage,
      reply: fakeReply,
      sceneLocks: locks,
      now: 1_000_000 + i * 60_000,
    });

    const unfinished = sessionHooksToUnfinished(thread);
    const goals = buildConversationGoals({
      desires: s.desires || {},
      storyBeat: s.storyBeat || null,
      unfinished,
      userMessage,
      sceneLocks: locks,
      outfit: s.outfit,
      intimacy: intimacyPhase ? { scene_phase: intimacyPhase } : null,
    });

    lastStructured = planStructuredHeuristic({
      userMessage,
      sceneLocks: locks,
      goals,
      behavior,
      unfinished,
      storyBeat: s.storyBeat,
      intimacyPhase,
    });

    history.push({ role: 'user', content: userMessage });
    if (fakeReply) history.push({ role: 'assistant', content: fakeReply });

    // 可选：假坏回复应被抓
    if (turn.expectBadReply) {
      const bad = detectNonSequitur(turn.expectBadReply, locks);
      const drift = detectSessionDrift(turn.expectBadReply, thread);
      checks.push([
        `t${i + 1} bad reply flagged`,
        bad.bad === true || drift.drift === true,
      ]);
    }
  }

  const system = buildSystemPrompt({
    sessionThreadPrompt: sessionThreadToPrompt(thread),
    structuredPlanPrompt: lastStructured
      ? `【本轮决策】态度=${lastStructured.attitude}`
      : '',
    coherencePrompt: lastLocks.length ? '【连贯性·硬规则】' : '',
  });

  checks.push(['thread turns', thread.turnCount === (s.turns || []).length]);
  checks.push(['system has session', system.includes('本场在聊') || (s.turns || []).length === 0]);

  if (s.expect?.primaryTopic) {
    checks.push([`primary=${s.expect.primaryTopic}`, thread.primaryTopic === s.expect.primaryTopic]);
  }
  if (s.expect?.topicsInclude) {
    checks.push([
      'topics include',
      s.expect.topicsInclude.every((t) => (thread.topics || []).includes(t)),
    ]);
  }
  if (s.expect?.hasOpenQuestion) {
    checks.push(['has open question', (thread.openQuestions || []).length > 0]);
  }
  if (s.expect?.hasOpenCommitment) {
    checks.push([
      'has commitment',
      (thread.commitments || []).some((c) => c.status === 'open'),
    ]);
  }
  if (s.expect?.emotionalTone) {
    checks.push([`tone=${s.expect.emotionalTone}`, thread.emotionalTone === s.expect.emotionalTone]);
  }
  if (s.expect?.structuredAttitude) {
    checks.push([
      `attitude=${s.expect.structuredAttitude}`,
      lastStructured?.attitude === s.expect.structuredAttitude,
    ]);
  }
  if (s.expect?.sceneLock) {
    checks.push([
      `lock=${s.expect.sceneLock}`,
      lastLocks.some((l) => l.id === s.expect.sceneLock),
    ]);
  }
  if (s.expect?.wantPhoto != null) {
    checks.push([`wantPhoto=${s.expect.wantPhoto}`, lastStructured?.wantPhoto === s.expect.wantPhoto]);
  }

  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) {
    failed++;
    console.error(`✗ ${s.id}: ${bad.map(([n]) => n).join(', ')}`);
    console.error(
      `   topic=${thread.primaryTopic} tone=${thread.emotionalTone} q=${thread.openQuestions.length} c=${thread.commitments.filter((x) => x.status === 'open').length}`,
    );
  } else {
    passed++;
    console.log(
      `✓ ${s.id}: ${s.title} · ${thread.primaryTopic || '-'} · turns=${thread.turnCount} · ${thread.emotionalTone}`,
    );
  }
}

if (scenarios.length < 8) {
  console.error(`\n期望至少 8 段回放，当前 ${scenarios.length}`);
  process.exit(1);
}
if (failed) {
  console.error(`\nreplay-sessions failed: ${failed}/${scenarios.length}`);
  process.exit(1);
}
console.log(`\nreplay-sessions passed: ${passed}/${scenarios.length} ✅`);
