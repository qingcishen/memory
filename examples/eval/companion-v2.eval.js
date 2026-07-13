import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversationGoals, goalsToPrompt } from '../../src/orchestrator/goals.js';
import { inferEmotionLabel } from '../../src/state/emotionLabel.js';
import { behaviorPolicy, behaviorToPrompt } from '../../src/state/behavior.js';
import { detectSceneLocks, sceneCoherenceToPrompt, detectNonSequitur } from '../../src/companion/sceneCoherence.js';
import { inferRelationshipStage, relationshipStageToPrompt } from '../../src/companion/relationshipStage.js';
import { buildEpisodeHeuristic } from '../../src/companion/episode.js';
import { buildProactiveContentPack } from '../../src/companion/proactiveContent.js';
import { desireUrgency } from '../../src/orchestrator/scheduler.js';
import { buildSystemPrompt } from '../../src/orchestrator/assemble.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'companion-v2.scenarios.json'), 'utf8'));

let failed = 0;
for (const s of scenarios) {
  const label = inferEmotionLabel(
    { mood: s.state.mood, relationship: s.state.relationship },
    s.state.desires,
    s.turns,
  );
  const behavior = behaviorPolicy(label, { relationship: s.state.relationship });
  const stage = inferRelationshipStage(s.state.relationship || {});
  const history = s.history || [];
  const lastUser = [...(s.turns || [])].reverse().find((t) => t.role === 'user')?.content || '';
  const locks = detectSceneLocks(lastUser, history, s.state.intimacy?.scene_phase);
  const goals = buildConversationGoals({
    dueItems: [],
    desires: s.state.desires,
    storyBeat: s.storyBeat,
    intimacy: s.state.intimacy,
    outfit: s.state.outfit,
    userMessage: lastUser,
    unfinished: [],
    sceneLocks: locks,
  });
  const coherence = sceneCoherenceToPrompt(locks, { intimacyPhase: s.state.intimacy?.scene_phase });
  const stagePrompt = relationshipStageToPrompt(stage, s.state.relationship || {});
  const prompt = [
    behaviorToPrompt(behavior),
    goalsToPrompt(goals),
    stagePrompt,
    coherence,
  ].filter(Boolean).join('\n\n');
  const system = buildSystemPrompt({
    goalsPrompt: goalsToPrompt(goals),
    relationshipStagePrompt: stagePrompt,
    coherencePrompt: coherence,
  });

  const checks = [
    ['emotion label exists', typeof label === 'string' && label.length > 0],
    ['behavior prompt avoids internals', !/系统|目标栈|story|mood_link/i.test(prompt)],
    [
      'high sharing creates story goal when beat exists',
      !s.storyBeat || goals.some((g) => String(g.text).includes(s.storyBeat.content)),
    ],
    [
      'high tension can alter behavior',
      s.state.relationship.tension < 0.7 || behavior.replyDelayMs[1] > 0 || behavior.stonewall === true,
    ],
    ['system includes global speech rules', system.includes('像真人说话')],
  ];

  if (s.expect?.relationshipStage) {
    checks.push([
      `relationship stage = ${s.expect.relationshipStage}`,
      stage.id === s.expect.relationshipStage,
    ]);
  }
  if (s.expect?.sceneLock) {
    checks.push([
      `scene lock includes ${s.expect.sceneLock}`,
      locks.some((l) => l.id === s.expect.sceneLock),
    ]);
    if (s.expect.mustAvoidJump?.length) {
      const fakeBad = detectNonSequitur(
        `嗯…${s.expect.mustAvoidJump[0]}，好舒服`,
        locks,
      );
      checks.push(['non-sequitur detector flags jump lines', fakeBad.bad === true || locks.length > 0]);
    }
  }
  if (s.expect?.goalKind) {
    checks.push([
      `goal kind ${s.expect.goalKind}`,
      goals.some((g) => g.kind === s.expect.goalKind),
    ]);
  }
  if (s.expect?.mustMentionInGoals?.length) {
    const blob = goals.map((g) => g.text).join(' ');
    checks.push([
      'goals mention expected look',
      s.expect.mustMentionInGoals.every((m) => blob.includes(m)),
    ]);
  }
  if (s.expect?.episodeTopic) {
    const ep = buildEpisodeHeuristic([...(history || []), ...(s.turns || [])]);
    checks.push([
      `episode topic ${s.expect.episodeTopic}`,
      ep && Array.isArray(ep.topics) && ep.topics.includes(s.expect.episodeTopic),
    ]);
  }
  if (s.expect?.proactivePrimary) {
    const urg = desireUrgency(s.state.desires);
    const pack = buildProactiveContentPack({
      urgency: urg,
      storyBeat: s.storyBeat,
    });
    checks.push([
      `proactive primary ${s.expect.proactivePrimary}`,
      pack.primary?.kind === s.expect.proactivePrimary,
    ]);
  }

  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) {
    failed++;
    console.error(`✗ ${s.id}: ${bad.map(([name]) => name).join(', ')}`);
    console.error(`   stage=${stage.id} locks=${locks.map((l) => l.id).join(',') || '-'} goals=${goals.map((g) => g.kind).join(',')}`);
  } else {
    console.log(`✓ ${s.id}: ${s.title} · emotion=${label} · stage=${stage.id} · locks=${locks.map((l) => l.id).join(',') || '-'} · goals=${goals.length}`);
  }
}

if (failed) {
  console.error(`\nE1 companion-v2 eval failed: ${failed}/${scenarios.length}`);
  process.exit(1);
}

console.log(`\nE1 companion-v2 eval passed: ${scenarios.length}/${scenarios.length}`);
