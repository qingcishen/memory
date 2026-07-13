/**
 * 多场景逻辑矩阵（无 LLM）
 * npm run eval:live-matrix
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferEmotionLabel } from '../../src/state/emotionLabel.js';
import { emptyEmotionResidue, seedResidueFromStoryBeat } from '../../src/state/emotionResidue.js';
import { detectSceneLocks, detectNonSequitur } from '../../src/companion/sceneCoherence.js';
import { planStructuredHeuristic } from '../../src/orchestrator/structuredPlan.js';
import { buildProactiveContentPack } from '../../src/companion/proactiveContent.js';
import { inferBodySituation, bodyIntimacyGate } from '../../src/companion/bodyState.js';
import { buildConversationGoals } from '../../src/orchestrator/goals.js';
import { behaviorPolicy } from '../../src/state/behavior.js';
import { applyStageToBehavior, inferRelationshipStage } from '../../src/companion/relationshipStage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-scenarios.json'), 'utf8'));

let failed = 0;
let passed = 0;
const backlog = [];

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runLogicScenario(s) {
  if (s.kind === 'proactive') {
    const calm = buildProactiveContentPack({
      silenceTier: s.proactive.silenceTier,
      emotionLabel: s.proactive.calmResidue.label,
      emotionResidue: s.proactive.calmResidue,
    });
    const hurt = buildProactiveContentPack({
      silenceTier: s.proactive.silenceTier,
      emotionLabel: s.proactive.hurtResidue.label,
      emotionResidue: s.proactive.hurtResidue,
    });
    if (s.expect?.proactiveReasonsDiffer) {
      ok(hurt.reason !== calm.reason, '委屈主动 reason 应不同于平静');
      ok(/委屈|别扭|闷/.test(hurt.reason + hurt.style), '委屈主动应带情绪口吻');
    }
    return;
  }

  if (s.kind === 'story_seed') {
    const { residual, changed } = seedResidueFromStoryBeat(emptyEmotionResidue(), s.beat);
    ok(changed && residual.label === s.expect.storySeedLabel, `story seed → ${s.expect.storySeedLabel}`);
    return;
  }

  let residual = emptyEmotionResidue();
  const history = [...(s.history || [])];
  const rel = s.state?.relationship || { closeness: 0.75, trust: 0.7, tension: 0.1, repair_debt: 0 };
  const emotion = s.state?.emotion || { valence: 0, warmth: rel.closeness ?? 0.7 };
  const desires = s.state?.desires || {};
  const bodySit = inferBodySituation(s.state?.life || {});

  for (let i = 0; i < (s.turns || []).length; i++) {
    const turn = s.turns[i];
    const exp = turn.expect || {};
    const turns = [...history, { role: 'user', content: turn.user }];
    const inferred = inferEmotionLabel(
      { emotion, relationship: rel, mood: emotion },
      desires,
      turns,
      { previousResidual: residual, userMessage: turn.user, withResidual: true },
    );
    const label = inferred.label;
    residual = inferred.residual;

    const locks = detectSceneLocks(turn.user, history, s.state?.intimacy?.scene_phase);
    let behavior = behaviorPolicy(label, { relationship: rel });
    behavior = applyStageToBehavior(behavior, inferRelationshipStage(rel));
    const goals = buildConversationGoals({
      desires,
      storyBeat: s.storyBeat,
      unfinished: [],
      userMessage: turn.user,
      sceneLocks: locks,
      outfit: s.state?.outfit,
      intimacy: s.state?.intimacy,
    });
    const structured = planStructuredHeuristic({
      userMessage: turn.user,
      sceneLocks: locks,
      goals,
      behavior,
      intimacyPhase: s.state?.intimacy?.scene_phase,
      bodySit,
      storyBeat: s.storyBeat,
    });

    if (exp.labelsAny?.length) {
      ok(exp.labelsAny.includes(label), `t${i + 1} label ${label} not in ${exp.labelsAny.join('|')}`);
    }
    if (exp.notLabels?.length) {
      ok(!exp.notLabels.includes(label), `t${i + 1} label should not be ${label}`);
    }
    if (exp.sceneLockAny?.length) {
      ok(
        exp.sceneLockAny.some((id) => locks.some((l) => l.id === id)),
        `t${i + 1} missing lock ${exp.sceneLockAny.join('|')} got ${locks.map((l) => l.id)}`,
      );
    }
    if (exp.structuredAttitudeAny?.length) {
      ok(
        exp.structuredAttitudeAny.includes(structured.attitude),
        `t${i + 1} attitude ${structured.attitude}`,
      );
    }
    if (exp.replyFormat) {
      ok(structured.replyFormat === exp.replyFormat, `t${i + 1} format ${structured.replyFormat}`);
    }
    if (exp.wantPhoto != null) {
      ok(structured.wantPhoto === exp.wantPhoto, `t${i + 1} wantPhoto`);
    }
    if (exp.bodyGateBlocksIntimate) {
      ok(bodyIntimacyGate(bodySit).allowIntimateInit === false, 'body gate');
    }
    if (exp.fakeBadReply && exp.fakeBadShouldFlag) {
      const bad = detectNonSequitur(exp.fakeBadReply, locks);
      ok(bad.bad === true, `t${i + 1} fake bad should flag`);
    }

    history.push({ role: 'user', content: turn.user });
    history.push({ role: 'assistant', content: turn.assistant || '…' });
  }
}

for (const s of scenarios) {
  if (s.liveOnly) {
    console.log(`○ ${s.id}: skip logic (liveOnly)`);
    continue;
  }
  try {
    runLogicScenario(s);
    passed++;
    console.log(`✓ ${s.id}: ${s.title}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${s.id}: ${e.message}`);
    backlog.push({ id: s.id, error: e.message });
  }
}

console.log(`\nlive-matrix logic: ${passed} passed, ${failed} failed, ${scenarios.filter((s) => s.liveOnly).length} liveOnly`);
if (backlog.length) {
  console.error('backlog:', JSON.stringify(backlog, null, 2));
  process.exit(1);
}
console.log('live-matrix passed ✅');
